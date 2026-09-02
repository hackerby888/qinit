// Reads a contract's state over an RPC client and hands the decoded bytes to the pure formatters.
import {
    decodeOutput,
    createQpiContainerView,
    qpiSnapshotSource,
    QpiContainerConsistencyError,
    QpiIncompleteReadError,
    type QpiByteSource,
} from "@qinit/proto";
import { AbiTypeKind, type AbiType } from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { hexToBytes } from "@qinit/core";
import {
    containerLayoutOf,
    containerLines,
    flatLine,
    fmtVal,
    formatStateValue,
    keyLabel,
    stateFieldsOf,
    linkedListValueLines,
    type StateContainerLayout,
    type StateField,
    type StateLine,
} from "./state-format";

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
    sourceField: StateField;
};
export type StateReader = {
    stateRead(slot: number, off: number, len: number): Promise<{ hex: string }>;
};
export type StateReadProgress = (field: string, completedBytes: number, totalBytes: number) => void;
export type StateReadOptions = {
    collapseContainersAtBytes?: number;
    containerIndexes?: ReadonlySet<number>;
    loadAllContainers?: boolean;
};

const MAX_STATE_READ = 4 * 1024 * 1024;
export const LARGE_STATE_CONTAINER_BYTES = 10 * 1024 * 1024;

function stateReadError(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

function stateByteSource(rpc: StateReader, contractIndex: number, field: StateField, onRead?: (completedBytes: number) => void): QpiByteSource {
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
                const { hex } = await rpc.stateRead(contractIndex, absoluteOffset + completedBytes, remainingBytes);
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

type FormattedContainerView = {
    stateLines: StateLine[];
    occupiedSlots: number;
    totalEntries: number;
};

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
            };
        }
        case AbiTypeKind.HASH_MAP: {
            if (container.kind !== "hashmap") {
                throw new Error(`invalid ${field.name} container type`);
            }
            const entries = await view.entries();
            const formatted = entries.map((entry) => ({
                slot: entry.slot,
                text: `${keyLabel(entry.key, container.key)} = ${formatStateValue(entry.value, container.value, full)}`,
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
                slot: entry.slot,
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
                slot: entry.povSlot,
                text: `${keyLabel(entry.pov)}: ${formatStateValue(entry.value, container.value, full)} (p${entry.priority})`,
            }));
            return {
                stateLines: containerLines(container.capacity, formatted, true),
                occupiedSlots: new Set(entries.map((entry) => entry.povSlot)).size,
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

// A value already in hand, in the rows `qinit state` draws: one per scalar field, a container as its
// block. Only a value that holds a container gets one; anything smaller reads better inline.
export async function valueBlock(bytes: Uint8Array, type: AbiType): Promise<StateLine[] | undefined> {
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
            lines.push({ label: field.name, text: formatStateValue(await decodeOutput(slice, field.abi!), field.abi!, true, true), filled: true });
            continue;
        }

        const { stateLines } = await formatContainerView(field, qpiSnapshotSource(slice), true);
        const rows = stateLines.length ? stateLines : [{ label: "", text: "empty", filled: false }];

        lines.push(...rows.map((line, index) => ({ label: index ? "" : field.name, text: flatLine(line), filled: line.filled })));
    }

    return lines;
}

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
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const formatted = await formatContainerView(field, stateByteSource(rpc, contractIndex, field, onRead), true);
            return {
                ...head,
                status: "loaded",
                occupiedSlots: formatted.occupiedSlots,
                totalEntries: formatted.totalEntries,
                lines: formatted.stateLines,
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

export interface DecodedState {
    fields: { name: string; value: string }[];
    containers: StateContainer[];
    complete: boolean;
}

// An Array field reads as its own block: one row per set element, zero runs collapsed into a skipped row.
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
            text: formatStateValue(entry.value, type.element, true),
            filled: true,
        });
        setCount++;
        nextIndex = entry.index + 1;
    }

    addZeroRange(nextIndex, type.count - 1);
    return { lines, setCount };
}

async function readBitArrayBlock(
    view: Extract<ReturnType<typeof createQpiContainerView>, { kind: AbiTypeKind.BIT_ARRAY }>,
): Promise<{ lines: StateLine[]; setCount: number }> {
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
    return { lines, setCount };
}

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
    });
    const fields = stateFieldsOf(idl);
    const containerCount = fields.filter((field) => field.container).length;
    for (const index of options.containerIndexes ?? []) {
        if (!Number.isSafeInteger(index) || index < 1 || index > containerCount) {
            throw new RangeError(`container index ${index} is outside 1..${containerCount}`);
        }
    }
    const decodedFields: { name: string; value: string }[] = [];
    const containers: StateContainer[] = [];
    let containerIndex = 0;

    // Fields read concurrently. A node answers about one request per tick, so reading them in sequence
    // pays that latency once per field for bytes that could all have been in flight together. Each field
    // still reads only the ranges it needs, and results land in declaration order regardless of finish order.
    const slots: { field: StateField; value?: string; container?: StateContainer }[] = fields.map((field) => ({ field }));
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

    for (const slot of slots) {
        const field = slot.field;
        if (field.bad) {
            slot.value = `(undecodable: ${field.type} — fields below not shown)`;
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
                slot.container = collapsedContainer(index, field, layout);
                continue;
            }

            totalBytes += field.size;
            const tracksReads = layout.kind === "array" || layout.kind === "bitarray";
            reads.push(
                readContainerBlock(rpc, contractIndex, index, field, layout, tracksReads ? trackField() : undefined).then((loaded) => {
                    slot.container = loaded;
                }),
            );
            continue;
        }

        totalBytes += field.size;
        const onRead = trackField();
        reads.push(
            (async () => {
                try {
                    const decoded = await decodeOutput(await readAllBytes(stateByteSource(rpc, contractIndex, field, onRead)), field.abi ?? field.type);
                    slot.value =
                        typeof decoded === "object" && decoded !== null
                            ? field.abi
                                ? formatStateValue(decoded, field.abi, true, true)
                                : fmtVal(decoded, true)
                            : String(decoded);
                } catch (error) {
                    slot.value = `(read failed: ${stateReadError(error)})`;
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

    for (const slot of slots) {
        if (slot.container) {
            containers.push(slot.container);
        } else if (slot.value !== undefined) {
            decodedFields.push({ name: slot.field.name, value: slot.value });
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

export function stateIsComplete(state: Pick<DecodedState, "fields" | "containers">): boolean {
    return (
        !state.fields.some((field) => field.value.includes("read failed") || field.value.includes("undecodable")) &&
        state.containers.every((container) => container.status !== "error")
    );
}
