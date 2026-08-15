import {
    decodeOutput,
    decodeLog,
    createQpiContainerView,
    QpiContainerConsistencyError,
    QpiIncompleteReadError,
    type DecodedLog,
    type QpiByteSource,
} from "@qinit/proto";
import { AbiTypeKind, type AbiType, type ContractIdl } from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { stateDiffLines, type StateDiffLine } from "./state-diff";
import { bytesToIdentity, hexToBytes, type DebugEntry } from "@qinit/core";

export { hexToBytes };

export type StateContainerLayout =
    | {
          kind: "array";
          element: AbiType;
          capacity: number;
      }
    | {
          kind: "bitarray";
          capacity: number;
      }
    | {
          kind: "hashmap";
          key: AbiType;
          value: AbiType;
          capacity: number;
      }
    | {
          kind: "hashset";
          key: AbiType;
          capacity: number;
      }
    | {
          kind: "collection";
          value: AbiType;
          capacity: number;
      }
    | {
          kind: "linkedlist";
          value: AbiType;
          capacity: number;
      };
export type StateField = {
    name: string;
    off: number;
    size: number;
    type: string;
    abi?: AbiType;
    container?: StateContainerLayout;
    bad?: boolean;
};
// One rendered row of a state block. The label is the bracket token the view highlights, and `filled`
// separates an occupied slot from a skipped range.
export type StateLine = { label: string; text: string; filled: boolean };
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

export const jstr = (value: any) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

const RUN_MIN = 6;
const MAX_ITEMS = 32;
const MAX_STATE_READ = 4 * 1024 * 1024;
export const LARGE_STATE_CONTAINER_BYTES = 10 * 1024 * 1024;

function groupedParts(parts: string[]): string[] {
    const groups: { value: string; count: number }[] = [];
    for (const part of parts) {
        const last = groups[groups.length - 1];
        if (last?.value === part) {
            last.count++;
        } else {
            groups.push({ value: part, count: 1 });
        }
    }
    return groups.flatMap((group) => (group.count >= RUN_MIN ? [`${group.value} ×${group.count}`] : Array(group.count).fill(group.value)));
}

export function fmtVal(value: any, full = false): string {
    if (Array.isArray(value)) {
        let parts = groupedParts(value.map((element) => fmtVal(element, full)));
        let suffix = "";

        if (!full && parts.length > MAX_ITEMS) {
            suffix = `, … +${parts.length - MAX_ITEMS} more (--all)`;
            parts = parts.slice(0, MAX_ITEMS);
        }

        return `[${parts.join(", ")}${suffix}]`;
    }
    if (value && typeof value === "object") {
        return jstr(value);
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    return typeof value === "bigint" ? value.toString() : String(value);
}

function limitedParts(parts: string[], full: boolean): string[] {
    if (full || parts.length <= MAX_ITEMS) {
        return parts;
    }
    return parts.slice(0, MAX_ITEMS).concat(`… +${parts.length - MAX_ITEMS} more (--all)`);
}

function formatBits(bitCount: number, valueAt: (index: number) => number, full: boolean): string {
    const parts: string[] = [];
    let zeroStart: number | undefined;

    const flushZeros = (end: number) => {
        if (zeroStart === undefined) {
            return;
        }
        const count = end - zeroStart + 1;
        const range = zeroStart === end ? `[${zeroStart}]` : `[${zeroStart}..${end}]`;
        parts.push(`${range}=0${count > 1 ? ` ×${count}` : ""} (skipped)`);
        zeroStart = undefined;
    };

    for (let index = 0; index < bitCount; index++) {
        if (valueAt(index) === 0) {
            zeroStart ??= index;
            continue;
        }
        flushZeros(index - 1);
        parts.push(`[${index}]=1`);
    }
    flushZeros(bitCount - 1);
    return limitedParts(parts, full).join(", ");
}

// A block row collapsed back to the one-line form the trace views and nested container values use.
const flatLine = (line: StateLine) => `${line.label} ${line.text}`;

function linkedListValueLines(value: { slot: number; value: unknown }[], valueType: AbiType, capacity: number, full: boolean): StateLine[] {
    const logical = value.map((entry, index) => ({
        label: `item[${index}] slot[${entry.slot}]`,
        text: `= ${formatStateValue(entry.value, valueType, full)}`,
        filled: true,
    }));
    return logical.concat(
        unoccupiedSlotLines(
            capacity,
            value.map((entry) => entry.slot),
        ),
    );
}

export function formatStateValue(value: unknown, type: AbiType, full: boolean, topLevel = false): string {
    switch (type.kind) {
        case AbiTypeKind.BIT_ARRAY: {
            const bits = Array.isArray(value) ? value : [];
            return formatBits(type.bitCount, (index) => Number(bits[index] ?? 0), full);
        }
        case AbiTypeKind.LINKED_LIST:
            return limitedParts(
                linkedListValueLines(Array.isArray(value) ? (value as { slot: number; value: unknown }[]) : [], type.value, type.capacity, full).map(flatLine),
                full,
            ).join(", ");
        case AbiTypeKind.STRUCT: {
            if (!type.fields.length) {
                return "{}";
            }
            const values = topLevel && type.fields.length === 1 ? [value] : Array.isArray(value) ? value : [];
            const rawParts = type.fields.map((field, index) => formatStateValue(values[index], field.type, full, false));
            // A one-field struct read as a whole field is its value, so it keeps the bare form.
            if (topLevel && type.fields.length === 1) {
                return rawParts[0];
            }

            const parts = limitedParts(
                type.fields.map((field, index) => `${field.name || index}: ${rawParts[index]}`),
                full,
            );
            return `{${parts.join(", ")}}`;
        }
        case AbiTypeKind.ARRAY: {
            const values = Array.isArray(value) ? value : [];
            return `[${limitedParts(groupedParts(values.map((element) => formatStateValue(element, type.element, full, false))), full).join(", ")}]`;
        }
        default:
            return fmtVal(value, full);
    }
}

// A struct key has to read like the value beside it, which takes the type — decoded structs are positional.
export const keyLabel = (key: unknown, type?: AbiType) => (typeof key === "string" ? key : type ? formatStateValue(key, type, false) : jstr(key));

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

function gapLine(start: number, end: number, collection = false): StateLine {
    const count = end - start + 1;
    const noun = collection ? "PoV slots" : "slots";
    const label = start === end ? `${noun.slice(0, -1)}[${start}]` : `${noun}[${start}..${end}]`;
    return { label, text: `(unoccupied ×${count}; skipped)`, filled: false };
}

function containerLines(capacity: number, entries: { slot: number; text: string }[], collection = false): StateLine[] {
    const lines: StateLine[] = [];
    const slots = [...new Set(entries.map((entry) => entry.slot))];
    let nextSlot = 0;
    let entryIndex = 0;

    const addGap = (start: number, end: number) => {
        if (end >= start) {
            lines.push(gapLine(start, end, collection));
        }
    };

    for (const slot of slots) {
        addGap(nextSlot, slot - 1);
        while (entries[entryIndex]?.slot === slot) {
            lines.push({
                label: `${collection ? "PoV" : "slot"}[${slot}]`,
                text: entries[entryIndex].text,
                filled: true,
            });
            entryIndex++;
        }
        nextSlot = slot + 1;
    }
    addGap(nextSlot, capacity - 1);
    return lines;
}

function unoccupiedSlotLines(capacity: number, occupied: number[]): StateLine[] {
    const lines: StateLine[] = [];
    const slots = [...new Set(occupied)].sort((left, right) => left - right);
    let nextSlot = 0;

    const addGap = (start: number, end: number) => {
        if (end >= start) {
            lines.push(gapLine(start, end));
        }
    };

    for (const slot of slots) {
        addGap(nextSlot, slot - 1);
        nextSlot = slot + 1;
    }
    addGap(nextSlot, capacity - 1);
    return lines;
}

function containerLayoutOf(type: AbiType): StateContainerLayout | undefined {
    switch (type.kind) {
        case AbiTypeKind.ARRAY:
            return {
                kind: "array",
                element: type.element,
                capacity: type.count,
            };
        case AbiTypeKind.BIT_ARRAY:
            return {
                kind: "bitarray",
                capacity: type.bitCount,
            };
        case AbiTypeKind.HASH_MAP:
            return {
                kind: "hashmap",
                key: type.key,
                value: type.value,
                capacity: type.capacity,
            };
        case AbiTypeKind.HASH_SET:
            return {
                kind: "hashset",
                key: type.key,
                capacity: type.capacity,
            };
        case AbiTypeKind.COLLECTION:
            return {
                kind: "collection",
                value: type.value,
                capacity: type.capacity,
            };
        case AbiTypeKind.LINKED_LIST:
            return {
                kind: "linkedlist",
                value: type.value,
                capacity: type.capacity,
            };
        default:
            return undefined;
    }
}

export function stateFieldsOf(idl: Pick<ContractIdl, "state">): StateField[] {
    return idl.state.fields.map((field) => ({
        name: field.name,
        off: field.offset,
        size: field.size,
        type: field.type.format,
        abi: field.type,
        container: containerLayoutOf(field.type),
    }));
}

export function enumMap(idl: Pick<ContractIdl, "enums">): Record<string, string> {
    const names: Record<string, string> = {};

    for (const item of idl.enums) {
        if (!/log/i.test(item.name)) {
            Object.assign(names, item.members);
        }
    }
    // Log enums win collisions with unrelated enum values.
    for (const item of idl.enums) {
        if (/log/i.test(item.name)) {
            Object.assign(names, item.members);
        }
    }

    return names;
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

export const sevColor = (severity: string) => (severity === "ERROR" ? "red" : severity === "WARN" ? "yellow" : severity === "INFO" ? "green" : undefined);

export interface DecodedTrace {
    inDecoded: string;
    outDecoded: string;
    caller: string;
    fields: StateField[];
    stateDiff: StateDiffLine[];
    logs: DecodedLog[];
}

export async function describeTrace(entry: DebugEntry, source: string | undefined, name: string, qpiHeader?: string): Promise<DecodedTrace> {
    let input = entry.inHex ? "0x" + entry.inHex : "(none)";
    let output = entry.outHex ? "0x" + entry.outHex : "(none)";
    let caller = "(none)";

    if (entry.kind === 1 && !/^0+$/.test(entry.invocator)) {
        try {
            caller = await bytesToIdentity(hexToBytes(entry.invocator));
        } catch {
            caller = "0x" + entry.invocator.slice(0, 16) + "…";
        }
    }

    let fields: StateField[] = [];
    let stateDiff: StateDiffLine[] = [];
    let logs: DecodedLog[] = [];

    if (source) {
        try {
            const idl = extractIdl(source, name, {
                slot: entry.index,
                qpiHeader,
            });
            const registered = entry.kind === 0 ? idl.functions : idl.procedures;
            const metadata = registered.find((candidate) => candidate.inputType === entry.entry);

            if (metadata && entry.inHex) {
                const decoded = await decodeOutput(hexToBytes(entry.inHex), metadata.input);
                input = formatStateValue(decoded, metadata.input, false, true);
            }
            if (metadata && entry.outHex) {
                const decoded = await decodeOutput(hexToBytes(entry.outHex), metadata.output);
                output = formatStateValue(decoded, metadata.output, false, true);
            }

            fields = stateFieldsOf(idl);
            stateDiff = await stateDiffLines(fields, entry.stateDiff);
            const enumNames = enumMap(idl);

            if (entry.logs?.length) {
                logs = await Promise.all(entry.logs.map((log) => decodeLog(log.type, log.size, log.hex, idl.logs, enumNames)));
            }
        } catch {
            // Raw trace bytes remain available when source decoding fails.
        }
    }

    return {
        inDecoded: input,
        outDecoded: output,
        caller,
        fields,
        stateDiff,
        logs,
    };
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

    // One pass, so the blocks below the scalar rows keep the order the fields are declared in.
    for (const field of fields) {
        if (field.bad) {
            decodedFields.push({
                name: field.name,
                value: `(undecodable: ${field.type} — fields below not shown)`,
            });
            continue;
        }

        if (field.container) {
            containerIndex++;
            const selected = options.containerIndexes?.has(containerIndex) ?? false;
            const collapsed =
                options.collapseContainersAtBytes !== undefined && field.size >= options.collapseContainersAtBytes && !selected && !options.loadAllContainers;

            if (collapsed) {
                containers.push(collapsedContainer(containerIndex, field, field.container));
            } else {
                onProgress?.(field.name, 0, field.size);
                let completedBytes = 0;
                const reportRead = (value: number) => {
                    completedBytes = value;
                    onProgress?.(field.name, value, field.size);
                };
                const tracksReads = field.container.kind === "array" || field.container.kind === "bitarray";
                containers.push(await readContainerBlock(rpc, contractIndex, containerIndex, field, field.container, tracksReads ? reportRead : undefined));
                if (!tracksReads && completedBytes < field.size) {
                    onProgress?.(field.name, field.size, field.size);
                }
            }
            continue;
        }

        onProgress?.(field.name, 0, field.size);
        try {
            const byteSource = stateByteSource(rpc, contractIndex, field, (completedBytes) => onProgress?.(field.name, completedBytes, field.size));
            const decoded = await decodeOutput(await readAllBytes(byteSource), field.abi ?? field.type);
            decodedFields.push({
                name: field.name,
                value:
                    typeof decoded === "object" && decoded !== null
                        ? field.abi
                            ? formatStateValue(decoded, field.abi, true, true)
                            : fmtVal(decoded, true)
                        : String(decoded),
            });
        } catch (error) {
            decodedFields.push({
                name: field.name,
                value: `(read failed: ${stateReadError(error)})`,
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

export function stateIsComplete(state: Pick<DecodedState, "fields" | "containers">): boolean {
    return (
        !state.fields.some((field) => field.value.includes("read failed") || field.value.includes("undecodable")) &&
        state.containers.every((container) => container.status !== "error")
    );
}
