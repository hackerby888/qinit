// Pure rendering of decoded state: values to text, container entries to rows. No I/O — everything
// here takes already-decoded bytes, so it is unit-testable without an RPC client.
import { AbiTypeKind, type AbiType, type ContractIdl } from "@qinit/proto/contract-idl";

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

export const jstr = (value: any) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

const RUN_MIN = 6;
const MAX_ITEMS = 32;

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
export const flatLine = (line: StateLine) => `${line.label} ${line.text}`;

export function linkedListValueLines(value: { slot: number; value: unknown }[], valueType: AbiType, capacity: number, full: boolean): StateLine[] {
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

// A value on its own: a string (an id, an m256i) reads bare, and anything nested keeps the quoted form
// `fmtVal` gives it, so a whole field, a print and a diff row all agree.
export function scalarText(value: unknown, type: AbiType): string {
    if (typeof value === "string") {
        return value;
    }
    return typeof value === "object" && value !== null ? formatStateValue(value, type, true, true) : String(value);
}

// A struct key has to read like the value beside it, which takes the type — decoded structs are positional.
export const keyLabel = (key: unknown, type?: AbiType) => (typeof key === "string" ? key : type ? formatStateValue(key, type, false) : jstr(key));

function gapLine(start: number, end: number, collection = false): StateLine {
    const count = end - start + 1;
    const noun = collection ? "PoV slots" : "slots";
    const label = start === end ? `${noun.slice(0, -1)}[${start}]` : `${noun}[${start}..${end}]`;
    return { label, text: `(unoccupied ×${count}; skipped)`, filled: false };
}

export function containerLines(capacity: number, entries: { slot: number; text: string }[], collection = false): StateLine[] {
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

export function unoccupiedSlotLines(capacity: number, occupied: number[]): StateLine[] {
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

export function containerLayoutOf(type: AbiType): StateContainerLayout | undefined {
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

// A container reached through plain struct fields still deserves its own block. One inside a container's
// element does not: a block per element would bury the container it lives in, so those stay inline.
export function holdsContainer(type: AbiType): boolean {
    if (containerLayoutOf(type)) {
        return true;
    }
    return type.kind === AbiTypeKind.STRUCT && type.fields.some((field) => holdsContainer(field.type));
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
