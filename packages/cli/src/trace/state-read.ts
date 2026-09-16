// Reads a contract's state over an RPC client and hands the decoded bytes to the pure formatters.
import {
    decodeAbi,
    createQpiContainerView,
    qpiSnapshotSource,
    QpiContainerConsistencyError,
    QpiIncompleteReadError,
    type QpiByteSource,
    decodedAbiToJson,
} from "@qinit/proto";
import { AbiTypeKind, type AbiType } from "@qinit/proto/contract-idl";
import { extractIdl, type CalleeSource } from "@qinit/build";
import { hexToBytes } from "@qinit/core";
import {
    containerLayoutOf,
    containerLines,
    flatLine,
    abiValueText,
    holdsContainer,
    keyLabel,
    scalarText,
    stateFieldsOf,
    linkedListValueLines,
    indexRuns,
    pastCapacityWarning,
    type StateContainerLayout,
    type StateField,
    type StateLine,
} from "./state-format";

// one block of `qinit state`, e.g. { index: 1, name: "values", kind: "array", status: "loaded", occupiedSlots: 2, totalEntries: 2, lines: [{ label: "[1]", text: "7", filled: true }] }
export type StateContainer = {
    index: number;
    name: string;
    kind: StateContainerLayout["kind"];
    size: number;
    status: "collapsed" | "loading" | "loaded" | "error";
    capacity: number;
    occupiedSlots: number;
    totalEntries: number;
    lines: StateLine[];
    error?: string;
    // not a failure: the rows are complete, and this names what in them the contract probably did not mean to write
    warnings?: string[];
    sourceField: StateField;
};
// the node's state read, e.g. stateRead(4, 136, 8) -> { hex: "0300000000000000" }, the population word of a map
export type StateReader = {
    // Absent on older nodes; the reader then makes no check.
    stateRead(slot: number, off: number, len: number): Promise<{ hex: string; version?: number }>;
};
// (field, bytes so far, bytes total), e.g. ("state", 4194304, 4194312)
export type StateReadProgress = (field: string, completedBytes: number, totalBytes: number) => void;
// e.g. { collapseContainersAtBytes: 1, containerIndexes: new Set([2]) } loads block 2 and collapses the rest
export type StateReadOptions = {
    collapseContainersAtBytes?: number;
    containerIndexes?: ReadonlySet<number>;
    loadAllContainers?: boolean;
    calleeSources?: readonly CalleeSource[];
};

// one rpc read at most, so a 4194312-byte array is fetched as 4194304 + 8
const MAX_STATE_READ = 4 * 1024 * 1024;
// a container this big comes back status "collapsed" with no read; --container N loads it on demand
export const LARGE_STATE_CONTAINER_BYTES = 10 * 1024 * 1024;

function stateReadError(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

// One source per field per attempt: the first read's version is what later reads must match.
// e.g. a 524288-byte field the node answers short -> reads [524288, 262144]; a version change mid-read throws "… changed while it was being read"
function stateByteSource(rpc: StateReader, contractIndex: number, field: StateField, onRead?: (completedBytes: number) => void): QpiByteSource {
    let seenVersion: number | undefined;

    return {
        byteLength: field.size,
        maxReadLength: MAX_STATE_READ,
        read: async (relativeOffset, length) => {
            if (
                !Number.isSafeInteger(relativeOffset) ||
                !Number.isSafeInteger(length) ||
                relativeOffset < 0 ||
                length < 0 ||
                length > MAX_STATE_READ ||
                relativeOffset + length > field.size ||
                !Number.isSafeInteger(field.off + relativeOffset)
            ) {
                throw new QpiIncompleteReadError(`invalid ${field.name} state byte range`);
            }

            const absoluteOffset = field.off + relativeOffset;
            const bytes = new Uint8Array(length);
            let completedBytes = 0;

            while (completedBytes < length) {
                const remainingBytes = length - completedBytes;
                const { hex, version } = await rpc.stateRead(contractIndex, absoluteOffset + completedBytes, remainingBytes);
                // Before hex validation, so a mid-write read is retryable, not malformed.
                if (version !== undefined) {
                    if (seenVersion === undefined) {
                        seenVersion = version;
                    } else if (version !== seenVersion) {
                        throw new QpiContainerConsistencyError(`${field.name} changed while it was being read (state version ${seenVersion} → ${version})`);
                    }
                }
                if (hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) {
                    throw new QpiIncompleteReadError(`invalid state read at ${absoluteOffset + completedBytes}`);
                }

                const chunk = hexToBytes(hex);
                if (!chunk.length || chunk.length > remainingBytes) {
                    throw new QpiIncompleteReadError(`short state read at ${absoluteOffset}: expected ${length} bytes, got ${completedBytes}`);
                }

                bytes.set(chunk, completedBytes);
                completedBytes += chunk.length;
                onRead?.(Math.min(relativeOffset + completedBytes, field.size));
            }

            return bytes;
        },
    };
}

async function readAllBytes(source: QpiByteSource): Promise<Uint8Array> {
    const bytes = new Uint8Array(source.byteLength);
    for (let offset = 0; offset < source.byteLength;) {
        const length = Math.min(source.maxReadLength, source.byteLength - offset);
        bytes.set(await source.read(offset, length), offset);
        offset += length;
    }
    return bytes;
}

// e.g. { stateLines: [{ label: "slot[1]", text: "11 = 101", filled: true }, …], occupiedSlots: 3, totalEntries: 3 }
type FormattedContainerView = {
    stateLines: StateLine[];
    occupiedSlots: number;
    totalEntries: number;
    warnings?: string[];
};

// a container's bytes -> its block rows, e.g. HashMap<uint64, uint64, 8> with 3 entries -> slot[1] 11 = 101, …, slots[3..5] (unoccupied ×3; skipped); a BitArray adds past-capacity warnings
async function formatContainerView(field: StateField, source: QpiByteSource, full: boolean): Promise<FormattedContainerView> {
    const container = field.container;
    if (!field.abi || !container) {
        throw new Error(`missing ${field.name} container type`);
    }

    const type = field.abi;
    switch (type.kind) {
        case AbiTypeKind.ARRAY:
        case AbiTypeKind.BIT_ARRAY:
        case AbiTypeKind.HASH_MAP:
        case AbiTypeKind.HASH_SET:
        case AbiTypeKind.COLLECTION:
        case AbiTypeKind.LINKED_LIST:
            break;
        default:
            throw new Error(`${field.name} is not a state container`);
    }

    const view = createQpiContainerView(type, source);
    switch (view.kind) {
        case AbiTypeKind.ARRAY: {
            if (container.kind !== "array") {
                throw new Error(`invalid ${field.name} container type`);
            }
            const formatted = await readArrayBlock(view);
            return {
                stateLines: formatted.lines,
                occupiedSlots: formatted.setCount,
                totalEntries: formatted.setCount,
            };
        }
        case AbiTypeKind.BIT_ARRAY: {
            if (container.kind !== "bitarray") {
                throw new Error(`invalid ${field.name} container type`);
            }
            const formatted = await readBitArrayBlock(view);
            return {
                stateLines: formatted.lines,
                occupiedSlots: formatted.setCount,
                totalEntries: formatted.setCount,
                ...(formatted.pastCapacity.length ? { warnings: [pastCapacityWarning("", view.capacity, formatted.pastCapacity)] } : {}),
            };
        }
        case AbiTypeKind.HASH_MAP: {
            if (container.kind !== "hashmap") {
                throw new Error(`invalid ${field.name} container type`);
            }
            const entries = await view.entries();
            // values render inline from decodeAbiValue, which keeps a BitArray's logical bits only; its past-capacity bits show in its own block and the diff, not here
            const formatted = entries.map((entry) => ({
                slot: entry.elementIndex,
                text: `${keyLabel(entry.key, container.key)} = ${abiValueText(entry.value, container.value, { showAll: full })}`,
            }));
            return {
                stateLines: containerLines(container.capacity, formatted),
                occupiedSlots: entries.length,
                totalEntries: entries.length,
            };
        }
        case AbiTypeKind.HASH_SET: {
            if (container.kind !== "hashset") {
                throw new Error(`invalid ${field.name} container type`);
            }
            const entries = await view.entries();
            const formatted = entries.map((entry) => ({
                slot: entry.elementIndex,
                text: keyLabel(entry.key, container.key),
            }));
            return {
                stateLines: containerLines(container.capacity, formatted),
                occupiedSlots: entries.length,
                totalEntries: entries.length,
            };
        }
        case AbiTypeKind.COLLECTION: {
            if (container.kind !== "collection") {
                throw new Error(`invalid ${field.name} container type`);
            }
            const entries = await view.entries();
            const formatted = entries.map((entry) => ({
                slot: entry.povIndex,
                text: `${keyLabel(entry.pov)}: ${abiValueText(entry.value, container.value, { showAll: full })} (p${entry.priority})`,
            }));
            return {
                stateLines: containerLines(container.capacity, formatted, true),
                occupiedSlots: new Set(entries.map((entry) => entry.povIndex)).size,
                totalEntries: entries.length,
            };
        }
        case AbiTypeKind.LINKED_LIST: {
            if (container.kind !== "linkedlist") {
                throw new Error(`invalid ${field.name} container type`);
            }
            const entries = await view.entries();
            return {
                stateLines: linkedListValueLines(entries, container.value, container.capacity, full),
                occupiedSlots: entries.length,
                totalEntries: entries.length,
            };
        }
        default:
            throw new Error(`${field.name} is not a state container`);
    }
}

// A value already in hand, in the rows `qinit state` draws: one per scalar field, a container as its block. Anything smaller than a container reads inline.
// e.g. a HashMap field bal with one entry -> [{ label: "bal", text: "slot[0] 11 = 101" }, { label: "", text: "slots[1..7] (unoccupied ×7; skipped)" }]; no container anywhere -> undefined
export async function valueLines(bytes: Uint8Array, type: AbiType): Promise<StateLine[] | undefined> {
    const container = containerLayoutOf(type);
    const fields: StateField[] =
        type.kind === AbiTypeKind.STRUCT
            ? stateFieldsOf({ state: type })
            : container
              ? [{ name: "", off: 0, size: type.size, type: type.format, abi: type, container }]
              : [];

    if (!fields.some((field) => field.container)) {
        return undefined;
    }

    const lines: StateLine[] = [];

    for (const field of fields) {
        const slice = bytes.subarray(field.off, field.off + field.size);

        if (!field.container) {
            lines.push({
                label: field.name,
                text: abiValueText(await decodeAbi(slice, field.abi!), field.abi!, { showAll: true, topLevel: true }),
                filled: true,
            });
            continue;
        }

        const { stateLines } = await formatContainerView(field, qpiSnapshotSource(slice), true);
        const rows = stateLines.length ? stateLines : [{ label: "", text: "empty", filled: false }];

        lines.push(...rows.map((line, index) => ({ label: index ? "" : field.name, text: flatLine(line), filled: line.filled })));
    }

    return lines;
}

/** The scalar rows and container blocks of one value, in the shape `qinit state` renders. */
export type ValueBlocks = { fields: StateFieldValue[]; containers: StateContainer[] };

// a struct -> one StateField per member; a bare container type -> one unnamed field covering it
function fieldsOfValue(type: AbiType): StateField[] {
    const container = containerLayoutOf(type);

    if (type.kind === AbiTypeKind.STRUCT && !container) {
        return stateFieldsOf({ state: type });
    }
    return container ? [{ name: "", off: 0, size: type.size, type: type.format, abi: type, container }] : [];
}

// How many container blocks a value contributes: a container is one, a struct sums its fields, and a container's own elements stay inline.
// e.g. { Array nums; Inner { HashMap map; uint64 tag } inner; HashSet set } -> 3, numbered nums=1, inner.map=2, set=3
export function countContainerBlocks(type: AbiType): number {
    if (containerLayoutOf(type)) {
        return 1;
    }
    if (type.kind === AbiTypeKind.STRUCT) {
        return type.fields.reduce((count, field) => count + countContainerBlocks(field.type), 0);
    }
    return 0;
}

/** A value already in hand, decoded into the rows `qinit state` draws. With `numbering` blocks continue the `--container` sequence; without it they use 0. */
export async function decodeValueBlocks(bytes: Uint8Array, type: AbiType, prefix = "", numbering?: { next: number }): Promise<ValueBlocks> {
    const blocks: ValueBlocks = { fields: [], containers: [] };

    for (const field of fieldsOfValue(type)) {
        const slice = bytes.subarray(field.off, field.off + field.size);
        const name = prefix + field.name;

        if (field.container) {
            const view = await formatContainerView(field, qpiSnapshotSource(slice), true);

            blocks.containers.push({
                index: numbering ? numbering.next++ : 0,
                name,
                kind: field.container.kind,
                size: field.size,
                status: "loaded",
                capacity: field.container.capacity,
                occupiedSlots: view.occupiedSlots,
                totalEntries: view.totalEntries,
                lines: view.stateLines,
                ...(view.warnings ? { warnings: view.warnings } : {}),
                sourceField: field,
            });
            continue;
        }

        if (holdsContainer(field.abi!)) {
            const nested = await decodeValueBlocks(slice, field.abi!, `${name}.`, numbering);

            blocks.fields.push(...nested.fields);
            blocks.containers.push(...nested.containers);
            continue;
        }

        const decoded = await decodeAbi(slice, field.abi!);
        blocks.fields.push({ name, value: scalarText(decoded, field.abi!), data: decodedAbiToJson(decoded, field.abi!) });
    }

    return blocks;
}

// one block over rpc, e.g. slot 7 field values -> { index: 1, status: "loaded", occupiedSlots: 1, lines }; an inconsistency that survives the retry -> status "error"
async function readContainerBlock(
    rpc: StateReader,
    contractIndex: number,
    index: number,
    field: StateField,
    container: StateContainerLayout,
    onRead?: (completedBytes: number) => void,
): Promise<StateContainer> {
    const head = {
        index,
        name: field.name,
        kind: container.kind,
        size: field.size,
        capacity: container.capacity,
        sourceField: field,
    };
    let lastError: unknown;

    // Separate range reads can span a state update, so one inconsistent view is retried before failing.
    // without a node version only an inconsistent view is caught: a read spanning a write that stays self-consistent renders as whole (core-lite sends no version)
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const formatted = await formatContainerView(field, stateByteSource(rpc, contractIndex, field, onRead), true);
            return {
                ...head,
                status: "loaded",
                occupiedSlots: formatted.occupiedSlots,
                totalEntries: formatted.totalEntries,
                lines: formatted.stateLines,
                ...(formatted.warnings ? { warnings: formatted.warnings } : {}),
            };
        } catch (error) {
            lastError = error;
            if (!(error instanceof QpiContainerConsistencyError)) {
                break;
            }
        }
    }

    return {
        ...head,
        status: "error",
        occupiedSlots: 0,
        totalEntries: 0,
        lines: [],
        error: stateReadError(lastError),
    };
}

// the placeholder for a block not read, e.g. { status: "collapsed", occupiedSlots: 0, lines: [] }
function collapsedContainer(index: number, field: StateField, container: StateContainerLayout): StateContainer {
    return {
        index,
        name: field.name,
        kind: container.kind,
        size: field.size,
        status: "collapsed",
        capacity: container.capacity,
        occupiedSlots: 0,
        totalEntries: 0,
        lines: [],
        sourceField: field,
    };
}

// a collapsed block -> the same block loaded: status "collapsed" -> "loaded" with its lines and occupiedSlots filled
export async function loadStateContainer(
    rpc: StateReader,
    contractIndex: number,
    container: StateContainer,
    onProgress?: StateReadProgress,
): Promise<StateContainer> {
    const field = container.sourceField;
    if (!field.container) {
        throw new Error(`${field.name} is not a state container`);
    }

    onProgress?.(field.name, 0, field.size);
    let completedBytes = 0;
    const reportRead = (value: number) => {
        completedBytes = value;
        onProgress?.(field.name, value, field.size);
    };
    const tracksReads = field.container.kind === "array" || field.container.kind === "bitarray";
    const loaded = await readContainerBlock(rpc, contractIndex, container.index, field, field.container, tracksReads ? reportRead : undefined);
    if (!tracksReads && completedBytes < field.size) {
        onProgress?.(field.name, field.size, field.size);
    }
    return loaded;
}

// e.g. { name: "counter", value: "7", data: 7n }, or { name: "value", value: "(read failed: short state read at 0: expected 8 bytes, got 4)", failed: true }
// `failed` marks that message, since a decoded value's text can contain the same words, e.g. a struct member named `undecodable`.
export type StateFieldValue = { name: string; value: string; data?: unknown; failed?: boolean };

// e.g. { fields: [{ name: "counter", value: "7", data: 7n }], containers: [<block bal>], complete: true }
export interface DecodedState {
    fields: StateFieldValue[];
    containers: StateContainer[];
    complete: boolean;
}

// An Array field reads as its own block: one row per set element, zero runs collapsed into a skipped row.
// e.g. two set slots of 524289 -> [0] =0 (skipped), [1] 7, [2..524287] =0 ×524286 (skipped), [524288] 9
async function readArrayBlock(
    view: Extract<ReturnType<typeof createQpiContainerView>, { kind: AbiTypeKind.ARRAY }>,
): Promise<{ lines: StateLine[]; setCount: number }> {
    const type = view.type;
    if (!type.count) {
        return { lines: [], setCount: 0 };
    }

    const lines: StateLine[] = [];
    let setCount = 0;
    let nextIndex = 0;

    const addZeroRange = (start: number, end: number) => {
        if (end < start) {
            return;
        }
        const count = end - start + 1;
        lines.push({
            label: start === end ? `[${start}]` : `[${start}..${end}]`,
            text: `=0${count > 1 ? ` ×${count}` : ""} (skipped)`,
            filled: false,
        });
    };

    for await (const entry of view.nonZeroEntries()) {
        addZeroRange(nextIndex, entry.index - 1);
        lines.push({
            label: `[${entry.index}]`,
            text: abiValueText(entry.value, type.element, { showAll: true }),
            filled: true,
        });
        setCount++;
        nextIndex = entry.index + 1;
    }

    addZeroRange(nextIndex, type.count - 1);
    return { lines, setCount };
}

// e.g. BitArray<2> with bits 0, 2, 4, 5, 63 set -> [0] =1, [1] =0 (skipped), [2] =1 (past capacity 2), [4..5] =1 ×2 (past capacity 2), [63] =1 (past capacity 2)
async function readBitArrayBlock(
    view: Extract<ReturnType<typeof createQpiContainerView>, { kind: AbiTypeKind.BIT_ARRAY }>,
): Promise<{ lines: StateLine[]; setCount: number; pastCapacity: number[] }> {
    const lines: StateLine[] = [];
    let setCount = 0;
    let nextIndex = 0;

    const addZeroRange = (start: number, end: number) => {
        if (end < start) {
            return;
        }
        const count = end - start + 1;
        lines.push({
            label: start === end ? `[${start}]` : `[${start}..${end}]`,
            text: `=0${count > 1 ? ` ×${count}` : ""} (skipped)`,
            filled: false,
        });
    };

    for await (const index of view.setBits()) {
        addZeroRange(nextIndex, index - 1);
        lines.push({ label: `[${index}]`, text: "=1", filled: true });
        setCount++;
        nextIndex = index + 1;
    }

    addZeroRange(nextIndex, view.capacity - 1);

    // bits past the capacity are a contract writing an out-of-range index; get(i) still sees them, so they show rather than vanish.
    const pastCapacity: number[] = [];
    for await (const index of view.setBitsPastCapacity()) {
        pastCapacity.push(index);
    }
    for (const [start, end] of indexRuns(pastCapacity)) {
        const count = end - start + 1;
        lines.push({
            label: start === end ? `[${start}]` : `[${start}..${end}]`,
            text: `=1${count > 1 ? ` ×${count}` : ""} (past capacity ${view.capacity})`,
            filled: true,
        });
    }

    return { lines, setCount, pastCapacity };
}

// the whole state of one contract, e.g. Counter at slot 7 -> { fields: [{ name: "counter", value: "7", data: 7n }], containers: [<bal block>], complete: true }
// scalars decode from one read each, containers become blocks, a struct holding containers splits into both
export async function readState(
    rpc: StateReader,
    contractIndex: number,
    source: string,
    name: string,
    qpiHeader?: string,
    onProgress?: StateReadProgress,
    options: StateReadOptions = {},
): Promise<DecodedState> {
    const idl = extractIdl(source, name, {
        slot: contractIndex,
        qpiHeader,
        calleeSources: options.calleeSources,
    });
    const fields = stateFieldsOf(idl);
    // Nested containers count too: the sequence is one walk over the state, so every block gets a number.
    const containerCount = fields.reduce((count, field) => count + (field.abi ? countContainerBlocks(field.abi) : 0), 0);
    for (const index of options.containerIndexes ?? []) {
        if (!Number.isSafeInteger(index) || index < 1 || index > containerCount) {
            throw new RangeError(`container index ${index} is outside 1..${containerCount}`);
        }
    }
    const decodedFields: { name: string; value: string }[] = [];
    const containers: StateContainer[] = [];
    let containerIndex = 0;

    // Fields read concurrently: a node answers about one request per tick, so sequence pays that latency per field. Results land in declaration order.
    const results: {
        field: StateField;
        value?: string;
        data?: unknown;
        failed?: boolean;
        container?: StateContainer;
        nested?: ValueBlocks;
        nestedFrom?: number;
    }[] = fields.map((field) => ({ field }));
    const reads: Promise<void>[] = [];
    let totalBytes = 0;
    let completedBytes = 0;
    // Progress is aggregate: with reads overlapping, a per-field percentage would jump between fields.
    const trackField = () => {
        let reported = 0;
        return (value: number) => {
            completedBytes += value - reported;
            reported = value;
            onProgress?.("state", completedBytes, totalBytes);
        };
    };

    for (const result of results) {
        const field = result.field;
        if (field.bad) {
            result.value = `(undecodable: ${field.type} — fields below not shown)`;
            result.failed = true;
            continue;
        }

        if (field.container) {
            containerIndex++;
            const index = containerIndex;
            const layout = field.container;
            const selected = options.containerIndexes?.has(index) ?? false;
            const collapsed =
                options.collapseContainersAtBytes !== undefined && field.size >= options.collapseContainersAtBytes && !selected && !options.loadAllContainers;

            if (collapsed) {
                result.container = collapsedContainer(index, field, layout);
                continue;
            }

            totalBytes += field.size;
            const tracksReads = layout.kind === "array" || layout.kind === "bitarray";
            reads.push(
                readContainerBlock(rpc, contractIndex, index, field, layout, tracksReads ? trackField() : undefined).then((loaded) => {
                    result.container = loaded;
                }),
            );
            continue;
        }

        // A struct field holding containers takes the next numbers in declaration order, before its bytes arrive.
        if (field.abi && holdsContainer(field.abi)) {
            result.nestedFrom = containerIndex + 1;
            containerIndex += countContainerBlocks(field.abi);
        }

        totalBytes += field.size;
        const onRead = trackField();
        reads.push(
            (async () => {
                try {
                    const bytes = await readAllBytes(stateByteSource(rpc, contractIndex, field, onRead));

                    // A struct field can hold a container of its own; rendered as one value it would be a line of JSON, so it takes the state rows instead.
                    if (field.abi && holdsContainer(field.abi)) {
                        result.nested = await decodeValueBlocks(bytes, field.abi, `${field.name}.`, { next: result.nestedFrom! });
                        return;
                    }

                    const decoded = await decodeAbi(bytes, field.abi!);
                    result.value = scalarText(decoded, field.abi!);
                    result.data = decodedAbiToJson(decoded, field.abi!);
                } catch (error) {
                    result.value = `(read failed: ${stateReadError(error)})`;
                    result.failed = true;
                }
            })(),
        );
    }

    onProgress?.("state", 0, totalBytes);
    await Promise.all(reads);
    // Containers that read whole blocks report no byte progress of their own, so settle the bar at the end.
    if (completedBytes < totalBytes) {
        onProgress?.("state", totalBytes, totalBytes);
    }

    for (const result of results) {
        if (result.container) {
            containers.push(result.container);
        } else if (result.nested) {
            decodedFields.push(...result.nested.fields);
            containers.push(...result.nested.containers);
        } else if (result.value !== undefined) {
            decodedFields.push({
                name: result.field.name,
                value: result.value,
                ...(result.data !== undefined ? { data: result.data } : {}),
                ...(result.failed ? { failed: true } : {}),
            });
        }
    }

    const state = {
        fields: decodedFields,
        containers,
        complete: false,
    };
    state.complete = stateIsComplete(state);
    return state;
}

// false once any field failed; a collapsed container still counts as complete
export function stateIsComplete(state: Pick<DecodedState, "fields" | "containers">): boolean {
    return !state.fields.some((field) => field.failed) && state.containers.every((container) => container.status !== "error");
}
