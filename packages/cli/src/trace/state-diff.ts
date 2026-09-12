// Diffs read as fields/elements/members, not offsets and hex — container internals come from the member tables in @qinit/proto/qpi-layout.
import { decodeAbi, decodedAbiToJson } from "@qinit/proto";
import { AbiScalarKind, AbiTypeKind, type AbiType } from "@qinit/proto/contract-idl";
import {
    arrayGeometry,
    collectionMembers,
    hashMapMembers,
    hashSetMembers,
    linkedListMembers,
    type ContainerRegion,
    type MemberRole,
    type WordType,
} from "@qinit/proto/qpi-layout";
import type { DebugStateRegion } from "@qinit/core";
import { holdsContainer, keyLabel, scalarText, type StateField, type StateLine } from "./state-format";
import { hexToBytes } from "@qinit/core";

// A diff row keeps both label forms: `label` for the default view, `detail` the full path; `internal` marks container bookkeeping hidden until the full view.
export type StateDiffLine = StateLine & { detail: string; internal: boolean; before?: unknown; after?: unknown; change?: "new" | "removed" };

// Container bookkeeping is not in the IDL — its indices and counters are plain 64-bit words.
const wordType = (kind: AbiScalarKind, size = 8): AbiType => ({
    kind: AbiTypeKind.SCALAR,
    scalar: kind,
    size,
    align: 8,
    format: kind,
});
const WORD_TYPES: Record<WordType, AbiType> = {
    sint64: wordType(AbiScalarKind.SINT64),
    uint64: wordType(AbiScalarKind.UINT64),
    id: wordType(AbiScalarKind.ID, 32),
};

// Two names per leaf, the same pair a row carries: `detail` the resolved path through the container, `label` the shorter default view.
// They differ only where a path runs through container internals.
type Names = { detail: string; label: string };

// Extends both names one level deeper, e.g. `balances` + `.slot[3]`; the label suffix differs only inside container internals.
const descend = (names: Names, detailSuffix: string, labelSuffix = detailSuffix): Names => ({
    detail: names.detail + detailSuffix,
    label: names.label + labelSuffix,
});

// One record of a keyed container plus the absolute offset its key sits at, so the row is labelled by the key the contract wrote rather than the bucket it hashed into.
type ResolvedRecordKey = {
    part: "key" | "value";
    container: string;
    containerPath: string;
    slot: number;
    member: string;
    keyOff: number;
    keyType: AbiType;
};

// The records a flags run indexes, as geometry rather than one offset: a flipped flag has to name its entry even when the record itself is outside the window.
type RecordKeyGeometry = { container: string; containerPath: string; recordsOff: number; stride: number; keyOff: number; keyType: AbiType };

// A decodable value at an absolute state offset, or packed bits reporting one changed index at a time. `role` is which of the three kinds of byte this is:
// `payload` a value the contract wrote, `count` a container's entry total, `internal` the bookkeeping only the full view shows.
type Leaf = Names & { recordKey?: ResolvedRecordKey; flagRecords?: RecordKeyGeometry } & (
        | { kind: "value"; role: MemberRole; off: number; type: AbiType }
        | {
              kind: "bits";
              role: MemberRole;
              off: number;
              size: number;
              bitsPerIndex: number;
              indexCount: number;
          }
    );

// What a row contributes to its record's entry line. Both key images are kept because whether the entry arrived or left is only known once its flag turns up.
type RecordEntryRef = {
    part: "key" | "value";
    container: string;
    containerPath: string;
    slot: number;
    suffix: string;
    keyBefore?: string;
    keyAfter?: string;
    before: string;
    after: string;
    beforeData?: unknown;
    afterData?: unknown;
};
// `key` is set only for a flag that opened or closed an entry whose record sat in the same window.
type FlagEntryRef = { part: "flag"; container: string; containerPath: string; slot: number; from: number; to: number; key?: string };
type EntryRef = RecordEntryRef | FlagEntryRef;

// What identifies a keyed record's entry; the before and after images are the row's own.
type EntryIdentity = Omit<RecordEntryRef, "before" | "after">;

// A pass-one row plus the annotation pass two needs; absent for anything outside a container record.
type AnnotatedRow = StateDiffLine & { entryRef?: EntryRef };

// A decodable leaf at an absolute state offset — the `value` half of `Leaf`, paired with `bitsLeaf`.
const valueLeaf = (names: Names, off: number, type: AbiType, role: MemberRole = "payload"): Leaf => ({
    kind: "value",
    ...names,
    role,
    off,
    type,
});

// The member of `type` that byte `relativeOffset` falls in. Indexed collections resolve per element; a struct stops as one row when the window holds all of it.
// (names, absolute start of `type`, `type`, offset within it) -> the one named thing that byte belongs to.
function resolveLeaf(names: Names, typeStart: number, type: AbiType, relativeOffset: number, windowHolds: (off: number, size: number) => boolean): Leaf {
    switch (type.kind) {
        case AbiTypeKind.STRUCT: {
            // A struct holding a container is never one row: the container's members say what moved.
            if (!holdsContainer(type) && windowHolds(typeStart, type.size)) {
                return valueLeaf(names, typeStart, type);
            }

            const field = type.fields.find((candidate) => relativeOffset >= candidate.offset && relativeOffset < candidate.offset + candidate.size);
            if (!field) {
                // Padding inside the struct names nothing, so step the walk to the next field, or to the struct's end.
                const next = type.fields.find((candidate) => candidate.offset > relativeOffset);
                return paddingLeaf(names, typeStart + relativeOffset, (next?.offset ?? type.size) - relativeOffset);
            }
            return resolveLeaf(descend(names, `.${field.name}`), typeStart + field.offset, field.type, relativeOffset - field.offset, windowHolds);
        }

        case AbiTypeKind.ARRAY: {
            const { stride } = arrayGeometry(type.element, type.count);
            const index = Math.floor(relativeOffset / stride);
            const offsetInElement = relativeOffset - index * stride;
            const element = descend(names, `[${index}]`);
            const elementStart = typeStart + index * stride;
            if (offsetInElement >= type.element.size) {
                return valueLeaf(element, elementStart, type.element);
            }
            return resolveLeaf(element, elementStart, type.element, offsetInElement, windowHolds);
        }

        case AbiTypeKind.HASH_MAP:
            return memberLeaf(
                names,
                typeStart,
                relativeOffset,
                hashMapMembers(type.key, type.value, type.capacity),
                (tag) => (tag === "key" ? type.key : type.value),
                windowHolds,
            );

        case AbiTypeKind.HASH_SET:
            return memberLeaf(names, typeStart, relativeOffset, hashSetMembers(type.key, type.capacity), () => type.key, windowHolds);

        // Printing 256 bits twice to show one flip is the noise this whole module exists to remove.
        case AbiTypeKind.BIT_ARRAY:
            return bitsLeaf(names, typeStart, type.size, 1, type.bitCount, "payload");

        case AbiTypeKind.COLLECTION:
            return memberLeaf(names, typeStart, relativeOffset, collectionMembers(type.value, type.capacity), () => type.value, windowHolds);

        case AbiTypeKind.LINKED_LIST:
            return memberLeaf(names, typeStart, relativeOffset, linkedListMembers(type.value, type.capacity), () => type.value, windowHolds);

        default:
            return valueLeaf(names, typeStart, type);
    }
}

// Matching takes the first member whose end passes the offset, so C padding belongs to the member after it and the leaf always ends past `relativeOffset`.
// (container's absolute start, offset within it, its qpi-layout spans) -> that byte's leaf, tagged with the record key that names it.
function memberLeaf(
    names: Names,
    containerStart: number,
    relativeOffset: number,
    layout: ContainerRegion[],
    idlType: (tag: "key" | "value") => AbiType,
    windowHolds: (off: number, size: number) => boolean,
): Leaf {
    const span = layout.find((candidate) => relativeOffset < candidate.end) ?? layout[layout.length - 1];

    if (span.kind === "flags") {
        const bits = bitsLeaf(descend(names, span.path), containerStart + span.off, span.end - span.off, span.bitsPer, span.count, "internal");
        // Only a keyed container has anything better to label a record by than the bucket it hashed into.
        const records = layout.find((candidate): candidate is Extract<ContainerRegion, { kind: "records" }> => candidate.kind === "records");
        const keyMember = records?.members.find((candidate) => candidate.type === "key");
        if (!records || !keyMember) {
            return bits;
        }
        return {
            ...bits,
            flagRecords: {
                container: names.label,
                containerPath: names.detail,
                recordsOff: containerStart + records.off,
                stride: records.stride,
                keyOff: keyMember.off,
                keyType: idlType("key"),
            },
        };
    }

    if (span.kind === "word") {
        return valueLeaf(descend(names, span.path, span.short), containerStart + span.off, WORD_TYPES[span.type], span.role);
    }

    const index = Math.floor((relativeOffset - span.off) / span.stride);
    const offsetInRecord = relativeOffset - span.off - index * span.stride;
    const recordStart = containerStart + span.off + index * span.stride;
    const record = descend(names, `${span.path}[${index}]`, `${span.short}[${index}]`);

    const member = span.members.find((candidate) => offsetInRecord < candidate.off + candidate.size);
    if (!member) {
        // Trailing pad after a record's last member names nothing, so step the walk past the record.
        return paddingLeaf(record, recordStart + offsetInRecord, span.stride - offsetInRecord);
    }

    // qpi-layout spells the same pair `path`/`short`, so this is where its vocabulary meets this module's `detail`/`label`.
    const named = descend(record, member.path, member.short);
    if (member.type !== "key" && member.type !== "value") {
        return valueLeaf(named, recordStart + member.off, WORD_TYPES[member.type], member.role);
    }

    const leaf = resolveLeaf(named, recordStart + member.off, idlType(member.type), Math.max(0, offsetInRecord - member.off), windowHolds);
    const keyMember = span.members.find((candidate) => candidate.type === "key");
    if (!keyMember) {
        return leaf;
    }

    return {
        ...leaf,
        recordKey: {
            part: member.type,
            container: names.label,
            containerPath: names.detail,
            slot: index,
            member: named.label,
            keyOff: recordStart + keyMember.off,
            keyType: idlType("key"),
        },
    };
}

// `count` packed entries of `bitsPer` bits from an absolute state offset, reported as the indices that moved rather than as bytes.
const bitsLeaf = (names: Names, off: number, size: number, bitsPerIndex: number, indexCount: number, role: MemberRole): Leaf => ({
    kind: "bits",
    ...names,
    role,
    off,
    size,
    bitsPerIndex,
    indexCount,
});

// Bytes that name nothing — struct padding, a record's trailing pad. A zero-count bits leaf reports no row and still moves the walk past `length`.
const paddingLeaf = (names: Names, off: number, length: number): Leaf => bitsLeaf(names, off, length, 1, 0, "internal");

const allZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);
const bytesEqual = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Bytes + type -> display text and JSON data, e.g. `07 00 …` as uint64 -> `{ text: "7", data: 7n }`; an all-zero value collapses to `0`.
async function renderValue(bytes: Uint8Array, type: AbiType): Promise<{ text: string; data: unknown }> {
    const decoded = await decodeAbi(bytes, type);
    const data = decodedAbiToJson(decoded, type);
    if (allZero(bytes)) {
        return { text: "0", data }; // matches how `qinit state` collapses an untouched element
    }

    return { text: scalarText(decoded, type), data };
}

// Occupation flags and BitArrays are packed, so report the indices that moved, not the raw words; `firstVisibleIndex` is where the visible slice starts.
// (bits leaf, before/after slices, index the slice starts at) -> one row per index whose value moved.
function bitRows(leaf: Extract<Leaf, { kind: "bits" }>, before: Uint8Array, after: Uint8Array, firstVisibleIndex: number, entry?: EntryIdentity): AnnotatedRow[] {
    const rows: AnnotatedRow[] = [];
    const entryRefOf = (index: number, from: number, to: number): { entryRef: EntryRef } | Record<never, never> => {
        if (leaf.flagRecords) {
            return { entryRef: { part: "flag", container: leaf.flagRecords.container, containerPath: leaf.flagRecords.containerPath, slot: index, from, to } };
        }
        return entry ? { entryRef: { ...entry, suffix: `${entry.suffix}[${index}]`, before: String(from), after: String(to) } } : {};
    };
    const valueAt = (bytes: Uint8Array, index: number) => {
        const bit = (index - firstVisibleIndex) * leaf.bitsPerIndex;
        const byte = bytes[bit >> 3];
        if (byte === undefined) {
            return undefined;
        }
        const mask = (1 << leaf.bitsPerIndex) - 1;
        return (byte >> (bit & 7)) & mask;
    };

    // The slice only covers a bounded run of indices; without this the loop walks the whole capacity — 33M no-op turns per window on a 536 MB map.
    const visibleBits = Math.min(before.length, after.length) * 8;
    const lastIndex = Math.min(leaf.indexCount, firstVisibleIndex + Math.floor(visibleBits / leaf.bitsPerIndex));

    for (let index = firstVisibleIndex; index < lastIndex; index++) {
        const from = valueAt(before, index);
        const to = valueAt(after, index);
        if (from === undefined || to === undefined || from === to) {
            continue;
        }
        rows.push({
            label: `${leaf.label}[${index}]`,
            detail: `${leaf.detail}[${index}]`,
            text: `${from} → ${to}`,
            filled: true,
            internal: leaf.role === "internal",
            before: from,
            after: to,
            ...entryRefOf(index, from, to),
        });
    }

    return rows;
}

// The map key tying every row of one container entry together: container path + slot.
const groupOf = (entryRef: EntryRef) => `${entryRef.containerPath}#${entryRef.slot}`;

// A record is zeroed when its slot is vacated, so only an arriving entry still has its key in the after image; undefined means the window never carried it.
const keyForLabel = (entryRef: RecordEntryRef, flag: FlagEntryRef | undefined) => (flag && flag.to !== 1 ? entryRef.keyBefore : entryRef.keyAfter);

// An entry that just arrived has a zero before image, so `= v` says more than `0 → v`; one that left keeps its arrow, since the value it held is what matters.
function entryText(entryRef: RecordEntryRef, flag: FlagEntryRef | undefined): string {
    if (flag?.to === 1) {
        return `= ${entryRef.after} (new)`;
    }
    if (flag?.to === 2) {
        return `${entryRef.before} → (removed)`;
    }
    return `${entryRef.before} → ${entryRef.after}`;
}

// A record's rows all describe one entry, so they read as one line labelled by the key the contract wrote; the bucket stays on the full path.
// Pass one's physical rows -> one line per container entry.
function collapseEntries(rows: AnnotatedRow[]): StateDiffLine[] {
    const flags = new Map<string, FlagEntryRef>();
    const valued = new Set<string>();
    const keyRows = new Set<string>();
    const collapsed = new Set<string>();

    for (const { entryRef } of rows) {
        if (entryRef?.part === "flag") {
            flags.set(groupOf(entryRef), entryRef);
        } else if (entryRef?.part === "value") {
            valued.add(groupOf(entryRef));
        } else if (entryRef?.part === "key") {
            keyRows.add(groupOf(entryRef));
        }
    }

    for (const { entryRef } of rows) {
        if (entryRef?.part === "value" && keyForLabel(entryRef, flags.get(groupOf(entryRef))) !== undefined) {
            collapsed.add(groupOf(entryRef));
        }
    }

    return rows.map(({ entryRef, ...line }) => {
        if (!entryRef) {
            return line;
        }

        const group = groupOf(entryRef);

        if (entryRef.part === "flag") {
            // An entry whose key and value both stayed zero left only its flag, which then names it.
            if (entryRef.key !== undefined && !valued.has(group) && !keyRows.has(group)) {
                return { ...line, label: `${entryRef.container}[${entryRef.key}]`, text: entryRef.to === 1 ? "(new)" : "(removed)", internal: false, change: changeOf(entryRef) };
            }
            return line;
        }

        const flag = flags.get(group);
        const key = keyForLabel(entryRef, flag);
        const labelled = key === undefined ? line.label : `${entryRef.container}[${key}]${entryRef.suffix}`;

        if (entryRef.part === "value") {
            return key === undefined ? line : { ...line, label: labelled, text: entryText(entryRef, flag), change: changeOf(flag) };
        }

        // The entry line already names the key, so a key row is noise — unless nothing else carries the entry, as with a value that was and stays zero.
        if (collapsed.has(group)) {
            return { ...line, internal: true };
        }
        if (valued.has(group) || !flag || key === undefined) {
            return line;
        }
        return { ...line, label: labelled, text: flag.to === 1 ? "(new)" : flag.to === 2 ? "(removed)" : line.text, change: changeOf(flag) };
    });
}

// A flag's new value as the row's change kind: 1 -> new, 2 -> removed, anything else -> undefined.
const changeOf = (flag: FlagEntryRef | undefined): "new" | "removed" | undefined => (flag?.to === 1 ? "new" : flag?.to === 2 ? "removed" : undefined);

// A value straddling two windows can only be decoded once they are one range — core reports per dirty page, so a record crossing a page arrives split.
// Only exactly-adjacent runs merge; the `/ 2` is because the images are hex.
function mergeAdjacentWindows(changedWindows: DebugStateRegion[]): DebugStateRegion[] {
    const joined: DebugStateRegion[] = [];

    for (const changedWindow of [...changedWindows].sort((left, right) => left.off - right.off)) {
        const last = joined[joined.length - 1];
        if (last && last.off + last.before.length / 2 === changedWindow.off) {
            last.before += changedWindow.before;
            last.after += changedWindow.after;
            continue;
        }

        joined.push({ ...changedWindow });
    }

    return joined;
}

// Every changed window, resolved and decoded. Windows may be minimal runs or aligned pages; a run not covering a whole value keeps its bytes.
// (the IDL's state fields, the engine's changed windows) -> one row per change, named by field, element or entry.
export async function stateDiffLines(fields: StateField[], changedWindows: DebugStateRegion[]): Promise<StateDiffLine[]> {
    const rows: AnnotatedRow[] = [];

    for (const changedWindow of mergeAdjacentWindows(changedWindows)) {
        const before = hexToBytes(changedWindow.before);
        const after = hexToBytes(changedWindow.after);
        const windowEnd = changedWindow.off + Math.min(before.length, after.length);
        // An absolute state range as a window-relative slice of `before` or `after`.
        const slice = (bytes: Uint8Array, from: number, to: number) => bytes.slice(from - changedWindow.off, to - changedWindow.off);

        // Key bytes -> the label text the entry's rows are named by.
        const keyText = async (bytes: Uint8Array, type: AbiType) => keyLabel(await decodeAbi(bytes, type), type);

        // The key labelling a record is read from the window, not the rows: an update leaves the key bytes alone, so it never produces a row of its own.
        const entryIdentityOf = async (recordKey: ResolvedRecordKey, label: string): Promise<EntryIdentity | undefined> => {
            const keyEnd = recordKey.keyOff + recordKey.keyType.size;
            if (recordKey.keyOff < changedWindow.off || keyEnd > windowEnd) {
                return undefined;
            }

            return {
                part: recordKey.part,
                container: recordKey.container,
                containerPath: recordKey.containerPath,
                slot: recordKey.slot,
                suffix: label.slice(recordKey.member.length),
                keyBefore: await keyText(slice(before, recordKey.keyOff, keyEnd), recordKey.keyType),
                keyAfter: await keyText(slice(after, recordKey.keyOff, keyEnd), recordKey.keyType),
            };
        };

        // A flag that opened or closed an entry carries its key when the record is in the window — the only name an all-zero entry can ever get.
        const namedFlags = (flagged: AnnotatedRow[], flagRecords: RecordKeyGeometry): Promise<AnnotatedRow[]> =>
            Promise.all(
                flagged.map(async (row) => {
                    const entryRef = row.entryRef;
                    if (entryRef?.part !== "flag" || (entryRef.to !== 1 && entryRef.to !== 2)) {
                        return row;
                    }
                    const keyStart = flagRecords.recordsOff + entryRef.slot * flagRecords.stride + flagRecords.keyOff;
                    const keyEnd = keyStart + flagRecords.keyType.size;
                    if (keyStart < changedWindow.off || keyEnd > windowEnd) {
                        return row;
                    }
                    return { ...row, entryRef: { ...entryRef, key: await keyText(slice(entryRef.to === 1 ? after : before, keyStart, keyEnd), flagRecords.keyType) } };
                }),
            );

        let stateOffset = changedWindow.off;

        while (stateOffset < windowEnd) {
            const field = fields.find((candidate) => stateOffset >= candidate.off && stateOffset < candidate.off + candidate.size);
            const reportUnknownBytes = () => {
                rows.push({
                    label: `@${stateOffset}`,
                    detail: `@${stateOffset}`,
                    text: "(outside any known field)",
                    filled: false,
                    internal: false,
                });
            };

            if (!field) {
                const next = fields.find((candidate) => candidate.off > stateOffset);

                // Alignment padding between two fields belongs to neither, so step over it: stopping here drops every later row in the window.
                if (next && next.off < windowEnd) {
                    if (!bytesEqual(slice(before, stateOffset, next.off), slice(after, stateOffset, next.off))) {
                        reportUnknownBytes();
                    }
                    stateOffset = next.off;
                    continue;
                }

                // Past the last field, alignment slack and a changedWindow longer than the whole state look the same, and the second is worth saying.
                reportUnknownBytes();
                break;
            }

            // A field with no ABI cannot be decoded at all, which is still a reason to stop.
            if (!field.abi) {
                reportUnknownBytes();
                break;
            }

            const leaf = resolveLeaf(
                { detail: field.name, label: field.name },
                field.off,
                field.abi,
                stateOffset - field.off,
                (off, size) => off >= changedWindow.off && off + size <= windowEnd,
            );

            if (leaf.kind === "bits") {
                // The whole flags run starts at `leaf.off`, which may be windows behind this one.
                const visibleStart = Math.max(leaf.off, changedWindow.off);
                const visibleEnd = Math.min(leaf.off + leaf.size, windowEnd);
                const firstVisibleIndex = ((visibleStart - leaf.off) * 8) / leaf.bitsPerIndex;
                const entry = leaf.recordKey ? await entryIdentityOf(leaf.recordKey, leaf.label) : undefined;
                const flagged = bitRows(leaf, slice(before, visibleStart, visibleEnd), slice(after, visibleStart, visibleEnd), firstVisibleIndex, entry);
                rows.push(...(leaf.flagRecords ? await namedFlags(flagged, leaf.flagRecords) : flagged));
                stateOffset = visibleEnd;
                continue;
            }

            const valueEnd = leaf.off + leaf.type.size;
            const visibleStart = Math.max(leaf.off, changedWindow.off);
            const visibleEnd = Math.min(valueEnd, windowEnd);
            const beforeBytes = slice(before, visibleStart, visibleEnd);
            const afterBytes = slice(after, visibleStart, visibleEnd);

            // A window carries unchanged bytes around the ones that moved; only the latter are worth a row.
            if (!bytesEqual(beforeBytes, afterBytes)) {
                const internal = leaf.role === "internal";
                if (leaf.off >= changedWindow.off && valueEnd <= windowEnd) {
                    const renderedBefore = await renderValue(beforeBytes, leaf.type);
                    const renderedAfter = await renderValue(afterBytes, leaf.type);
                    const change = `${renderedBefore.text} → ${renderedAfter.text}`;
                    const entry = leaf.recordKey ? await entryIdentityOf(leaf.recordKey, leaf.label) : undefined;
                    const entryRef = entry
                        ? { ...entry, before: renderedBefore.text, after: renderedAfter.text, beforeData: renderedBefore.data, afterData: renderedAfter.data }
                        : undefined;
                    rows.push({
                        label: leaf.label,
                        detail: leaf.detail,
                        text: leaf.role === "count" ? `${change} entries` : change,
                        filled: true,
                        internal,
                        before: renderedBefore.data,
                        after: renderedAfter.data,
                        ...(entryRef ? { entryRef } : {}),
                    });
                } else {
                    // A partial run: report the bytes that did change rather than invent the ones that did not.
                    const inside = `+${visibleStart - leaf.off}`;
                    rows.push({
                        label: leaf.label + inside,
                        detail: leaf.detail + inside,
                        text: `0x${toHex(beforeBytes)} → 0x${toHex(afterBytes)}`,
                        filled: true,
                        internal,
                        before: `0x${toHex(beforeBytes)}`,
                        after: `0x${toHex(afterBytes)}`,
                    });
                }
            }

            stateOffset = Math.max(valueEnd, stateOffset + 1);
        }
    }

    return collapseEntries(rows);
}
