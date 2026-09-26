// Pure rendering of decoded state: values to text, container entries to rows. No I/O, so it is unit-testable without an RPC client.
import { AbiTypeKind, type AbiType, type ContractIdl } from "@qinit/proto/contract-idl";

// what a state field's container is, e.g. { kind: "hashmap", key: <uint64>, value: <uint64>, capacity: 8 } or { kind: "bitarray", capacity: 2 }
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
// one top-level state field, e.g. { name: "map", off: 64, size: 152, container: { kind: "hashmap", capacity: 8 } }; bad marks a type the decoder cannot read
export type StateField = {
    name: string;
    off: number;
    size: number;
    type: string;
    abi?: AbiType;
    container?: StateContainerLayout;
    bad?: boolean;
};
// One rendered row of a state block: the label is the bracket token the view highlights, and `filled` separates an occupied slot from a skipped range.
// e.g. { label: "slot[1]", text: "11 = 101", filled: true } vs { label: "slots[3..5]", text: "(unoccupied ×3; skipped)", filled: false }
export type StateLine = { label: string; text: string; filled: boolean };

// JSON.stringify throws on a bigint, and a uint64 past 2^53 would lose digits as a number anyway.
export const bigintText = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);
export const jsonText = (value: any) => JSON.stringify(value, bigintText);

const RUN_MIN = 6;
const MAX_ITEMS = 32;

// runs of RUN_MIN or more equal parts fold, e.g. ["1", "2", "2", "2", "2", "2", "2", "3"] -> ["1", "2 ×6", "3"]
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

// A value with no type in hand -> display text, e.g. [1, 2, 2, 2, 2, 2, 2] -> "[1, 2 ×6]"; capped at MAX_ITEMS unless `full`.
export function valueText(value: any, full = false): string {
    if (Array.isArray(value)) {
        let parts = groupedParts(value.map((element) => valueText(element, full)));
        let suffix = "";

        if (!full && parts.length > MAX_ITEMS) {
            suffix = `, … +${parts.length - MAX_ITEMS} more (--all)`;
            parts = parts.slice(0, MAX_ITEMS);
        }

        return `[${parts.join(", ")}${suffix}]`;
    }
    if (value && typeof value === "object") {
        return jsonText(value);
    }
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    return typeof value === "bigint" ? value.toString() : String(value);
}

// the first 32 parts plus "… +18 more (--all)" unless full
function limitedParts(parts: string[], full: boolean): string[] {
    if (full || parts.length <= MAX_ITEMS) {
        return parts;
    }
    return parts.slice(0, MAX_ITEMS).concat(`… +${parts.length - MAX_ITEMS} more (--all)`);
}

// e.g. BitArray<128> with only bit 63 set -> "[0..62]=0 ×63 (skipped), [63]=1, [64..127]=0 ×64 (skipped)"
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
// e.g. { label: "slot[1]", text: "11 = 101" } -> "slot[1] 11 = 101"
export const flatLine = (line: StateLine) => `${line.label} ${line.text}`;

// ascending indexes folded into [start, end] runs, e.g. [20, 22, 23] -> [[20, 20], [22, 23]]
export function indexRuns(indexes: readonly number[]): [number, number][] {
    const runs: [number, number][] = [];

    for (const index of indexes) {
        const last = runs[runs.length - 1];
        if (last && index === last[1] + 1) {
            last[1] = index;
        } else {
            runs.push([index, index]);
        }
    }

    return runs;
}

const PAST_CAPACITY_RUNS_SHOWN = 8;

// a BitArray under 64 bits still stores a whole word and core's set(i) masks only the word index, so an out-of-range index lands there and get(i) reads it back.
// e.g. ("m[7]", 16, [20]) -> "⚠ m[7]: bit 20 written past BitArray<16> capacity …", indexes folded to runs like "bits 2..4, 9"
export function pastCapacityWarning(path: string, capacity: number, indexes: readonly number[]): string {
    const runs = indexRuns(indexes);
    const shown = runs.slice(0, PAST_CAPACITY_RUNS_SHOWN);
    const hiddenBits = runs.slice(PAST_CAPACITY_RUNS_SHOWN).reduce((count, [start, end]) => count + end - start + 1, 0);
    const list = shown.map(([start, end]) => (start === end ? `${start}` : `${start}..${end}`)).join(", ") + (hiddenBits ? `, +${hiddenBits} more` : "");
    const noun = indexes.length === 1 ? "bit" : "bits";

    return `⚠ ${path ? `${path}: ` : ""}${noun} ${list} written past BitArray<${capacity}> capacity — set() got an index ≥ ${capacity}, which core doesn't reject and get(i) reads back; check the index`;
}

// list order first, then the free slots, e.g. nodes in slots 6, 1, 2 of 8 -> item[0] slot[6] = 66, item[1] slot[1] = 11, item[2] slot[2] = 22, slot[0] (unoccupied ×1; skipped), …
export function linkedListValueLines(value: { elementIndex: number; value: unknown }[], valueType: AbiType, capacity: number, full: boolean): StateLine[] {
    const logical = value.map((entry, index) => ({
        label: `item[${index}] slot[${entry.elementIndex}]`,
        text: `= ${abiValueText(entry.value, valueType, { showAll: full })}`,
        filled: true,
    }));
    return logical.concat(
        unoccupiedSlotLines(
            capacity,
            value.map((entry) => entry.elementIndex),
        ),
    );
}

// `showAll` lifts the 32-item cap (`… +N more (--all)`); `topLevel` lets a one-field struct read as its bare value.
export type AbiValueTextOptions = { showAll?: boolean; topLevel?: boolean };

// decoded abi value + its type -> display text: 1n as uint64 -> "1", [5, -6] as { sint32 x; sint32 y } -> "{x: 5, y: -6}", an id -> quoted, a BitArray -> index runs.
// display only, not the `--in` encoding: "1uint64" comes from proto's input-format, and this never parses back.
export function abiValueText(value: unknown, type: AbiType, { showAll = false, topLevel = false }: AbiValueTextOptions = {}): string {
    switch (type.kind) {
        case AbiTypeKind.BIT_ARRAY: {
            const bits = Array.isArray(value) ? value : [];
            return formatBits(type.bitCount, (index) => Number(bits[index] ?? 0), showAll);
        }
        case AbiTypeKind.LINKED_LIST:
            return limitedParts(
                linkedListValueLines(Array.isArray(value) ? (value as { elementIndex: number; value: unknown }[]) : [], type.value, type.capacity, showAll).map(
                    flatLine,
                ),
                showAll,
            ).join(", ");
        case AbiTypeKind.STRUCT: {
            if (!type.fields.length) {
                return "{}";
            }
            const values = topLevel && type.fields.length === 1 ? [value] : Array.isArray(value) ? value : [];
            const rawParts = type.fields.map((field, index) => abiValueText(values[index], field.type, { showAll }));
            // A one-field struct read as a whole field is its value, so it keeps the bare form.
            if (topLevel && type.fields.length === 1) {
                return rawParts[0];
            }

            const parts = limitedParts(
                type.fields.map((field, index) => `${field.name || index}: ${rawParts[index]}`),
                showAll,
            );
            return `{${parts.join(", ")}}`;
        }
        case AbiTypeKind.ARRAY: {
            const values = Array.isArray(value) ? value : [];
            return `[${limitedParts(groupedParts(values.map((element) => abiValueText(element, type.element, { showAll }))), showAll).join(", ")}]`;
        }
        // a keyed container held as a value reads as its block rows would, e.g. {7 = 9}, {7}, {PKTG…: 9 (p7)}; without this it fell to jsonText's [{"elementIndex":…}]
        case AbiTypeKind.HASH_MAP: {
            const entries = Array.isArray(value) ? (value as { key: unknown; value: unknown }[]) : [];
            return `{${limitedParts(
                entries.map((entry) => `${keyLabel(entry.key, type.key)} = ${abiValueText(entry.value, type.value, { showAll })}`),
                showAll,
            ).join(", ")}}`;
        }
        case AbiTypeKind.HASH_SET: {
            const entries = Array.isArray(value) ? (value as { key: unknown }[]) : [];
            return `{${limitedParts(
                entries.map((entry) => keyLabel(entry.key, type.key)),
                showAll,
            ).join(", ")}}`;
        }
        case AbiTypeKind.COLLECTION: {
            const entries = Array.isArray(value) ? (value as { pov: unknown; priority: bigint; value: unknown }[]) : [];
            return `{${limitedParts(
                entries.map((entry) => `${keyLabel(entry.pov)}: ${abiValueText(entry.value, type.value, { showAll })} (p${entry.priority})`),
                showAll,
            ).join(", ")}}`;
        }
        default:
            return valueText(value, showAll);
    }
}

// A value on its own: a string (an id, an m256i) reads bare, and anything nested keeps `valueText`'s quoted form, so field, print and diff row agree.
// e.g. "FXHS…" -> FXHS… bare, a struct -> {tag: 7, who: "FXHS…"}
export function scalarText(value: unknown, type: AbiType): string {
    if (typeof value === "string") {
        return value;
    }
    return typeof value === "object" && value !== null ? abiValueText(value, type, { showAll: true, topLevel: true }) : String(value);
}

// A struct key has to read like the value beside it, which takes the type — decoded structs are positional.
// e.g. ([1, 2], Point) -> "{x: 1, y: 2}", (7n, sint32) -> "7", an id -> itself
export const keyLabel = (key: unknown, type?: AbiType) => (typeof key === "string" ? key : type ? abiValueText(key, type) : jsonText(key));

// e.g. (3, 5) -> { label: "slots[3..5]", text: "(unoccupied ×3; skipped)", filled: false }; pov gaps read "PoV slot[0]"
function gapLine(start: number, end: number, collection = false): StateLine {
    const count = end - start + 1;
    const noun = collection ? "PoV slots" : "slots";
    const label = start === end ? `${noun.slice(0, -1)}[${start}]` : `${noun}[${start}..${end}]`;
    return { label, text: `(unoccupied ×${count}; skipped)`, filled: false };
}

// entries and gaps in slot order, e.g. entries in slots 1, 2, 6 of 8 -> slot[0] (unoccupied ×1; skipped), slot[1] 11 = 101, slot[2] 22 = 202, slots[3..5] (unoccupied ×3; skipped), slot[6] 66 = 606, slot[7] …
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

// e.g. (8, [6, 1, 2]) -> gap rows for slot[0], slots[3..5], slot[7]
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

// AbiType -> its layout, e.g. HashMap<uint64, uint64, 8> -> { kind: "hashmap", capacity: 8 }; a scalar or plain struct -> undefined
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

// A container reached through plain struct fields deserves its own block; one inside a container's element does not, since a block per element would bury it.
// e.g. struct Deeper { uint64 value; HashMap map } -> true, so it prints deeper.value and a deeper.map block; struct Point { sint32 x, y } -> false
export function holdsContainer(type: AbiType): boolean {
    if (containerLayoutOf(type)) {
        return true;
    }
    return type.kind === AbiTypeKind.STRUCT && type.fields.some((field) => holdsContainer(field.type));
}

// the IDL's state struct -> one StateField per top-level member, e.g. { uint64 counter; HashMap<uint64, uint64, 8> map } -> counter at 0 (8 bytes), map at 8 (152 bytes, hashmap)
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

// every enum's members in one map, e.g. { "0": "Ok", "1": "Insufficient" }, the lookup that names a log's _type
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
