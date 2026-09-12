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

// Two names per leaf: the resolved path through the container and the shorter default label. They differ only where a path runs through container internals.
type Names = { path: string; short: string };

const child = (names: Names, suffix: string, shortSuffix = suffix): Names => ({
    path: names.path + suffix,
    short: names.short + shortSuffix,
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
              bitsPer: number;
              count: number;
          }
    );

// What a row contributes to its record's entry line. Both key images are kept because whether the entry arrived or left is only known once its flag turns up.
type EntrySite = {
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
type FlagSite = { part: "flag"; container: string; containerPath: string; slot: number; from: number; to: number; key?: string };
type RowSite = EntrySite | FlagSite;

// What identifies a keyed record's entry; the before and after images are the row's own.
type EntryBase = Omit<EntrySite, "before" | "after">;

type SitedRow = StateDiffLine & { site?: RowSite };

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
            return resolveLeaf(child(names, `.${field.name}`), typeStart + field.offset, field.type, relativeOffset - field.offset, windowHolds);
        }

        case AbiTypeKind.ARRAY: {
            const { stride } = arrayGeometry(type.element, type.count);
            const index = Math.floor(relativeOffset / stride);
            const offsetInElement = relativeOffset - index * stride;
            const element = child(names, `[${index}]`);
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
    regions: ContainerRegion[],
    idlType: (tag: "key" | "value") => AbiType,
    windowHolds: (off: number, size: number) => boolean,
): Leaf {
    const region = regions.find((candidate) => relativeOffset < candidate.end) ?? regions[regions.length - 1];

    if (region.kind === "flags") {
        const bits = bitsLeaf(child(names, region.path), containerStart + region.off, region.end - region.off, region.bitsPer, region.count, "internal");
        // Only a keyed container has anything better to label a record by than the bucket it hashed into.
        const records = regions.find((candidate): candidate is Extract<ContainerRegion, { kind: "records" }> => candidate.kind === "records");
        const keyMember = records?.members.find((member) => member.type === "key");
        if (!records || !keyMember) {
            return bits;
        }
        return {
            ...bits,
            flagRecords: {
                container: names.short,
                containerPath: names.path,
                recordsOff: containerStart + records.off,
                stride: records.stride,
                keyOff: keyMember.off,
                keyType: idlType("key"),
            },
        };
    }

    if (region.kind === "word") {
        return valueLeaf(child(names, region.path, region.short), containerStart + region.off, WORD_TYPES[region.type], region.role);
    }

    const index = Math.floor((relativeOffset - region.off) / region.stride);
    const offsetInRecord = relativeOffset - region.off - index * region.stride;
    const recordStart = containerStart + region.off + index * region.stride;
    const record = child(names, `${region.path}[${index}]`, `${region.short}[${index}]`);

    const found = region.members.find((candidate) => offsetInRecord < candidate.off + candidate.size);
    if (!found) {
        // Trailing pad after a record's last member names nothing, so step the walk past the record.
        return paddingLeaf(record, recordStart + offsetInRecord, region.stride - offsetInRecord);
    }

    const named = child(record, found.path, found.short);
    if (found.type !== "key" && found.type !== "value") {
        return valueLeaf(named, recordStart + found.off, WORD_TYPES[found.type], found.role);
    }

    const leaf = resolveLeaf(named, recordStart + found.off, idlType(found.type), Math.max(0, offsetInRecord - found.off), windowHolds);
    const keyMember = region.members.find((candidate) => candidate.type === "key");
    if (!keyMember) {
        return leaf;
    }

    return {
        ...leaf,
        recordKey: {
            part: found.type,
            container: names.short,
            containerPath: names.path,
            slot: index,
            member: named.short,
            keyOff: recordStart + keyMember.off,
            keyType: idlType("key"),
        },
    };
}

// `count` packed entries of `bitsPer` bits from an absolute state offset, reported as the indices that moved rather than as bytes.
const bitsLeaf = (names: Names, off: number, size: number, bitsPer: number, count: number, role: MemberRole): Leaf => ({
    kind: "bits",
    ...names,
    role,
    off,
    size,
    bitsPer,
    count,
});

// Bytes that name nothing — struct padding, a record's trailing pad. A zero-count bits leaf reports no row and still moves the walk past `length`.
const paddingLeaf = (names: Names, off: number, length: number): Leaf => bitsLeaf(names, off, length, 1, 0, "internal");

const allZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);
const bytesEqual = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function renderValue(bytes: Uint8Array, type: AbiType): Promise<{ text: string; data: unknown }> {
    const decoded = await decodeAbi(bytes, type);
    const data = decodedAbiToJson(decoded, type);
    if (allZero(bytes)) {
        return { text: "0", data }; // matches how `qinit state` collapses an untouched element
    }

    return { text: scalarText(decoded, type), data };
}

// Occupation flags and BitArrays are packed, so report the indices that moved, not the raw words; `firstVisibleIndex` is where the visible slice starts.
function bitRows(leaf: Extract<Leaf, { kind: "bits" }>, before: Uint8Array, after: Uint8Array, firstVisibleIndex: number, entry?: EntryBase): SitedRow[] {
    const rows: SitedRow[] = [];
    const siteOf = (index: number, from: number, to: number): { site: RowSite } | Record<never, never> => {
        if (leaf.flagRecords) {
            return { site: { part: "flag", container: leaf.flagRecords.container, containerPath: leaf.flagRecords.containerPath, slot: index, from, to } };
        }
        return entry ? { site: { ...entry, suffix: `${entry.suffix}[${index}]`, before: String(from), after: String(to) } } : {};
    };
    const valueAt = (bytes: Uint8Array, index: number) => {
        const bit = (index - firstVisibleIndex) * leaf.bitsPer;
        const byte = bytes[bit >> 3];
        if (byte === undefined) {
            return undefined;
        }
        const mask = (1 << leaf.bitsPer) - 1;
        return (byte >> (bit & 7)) & mask;
    };

    // The slice only covers a bounded run of indices; without this the loop walks the whole capacity — 33M no-op turns per window on a 536 MB map.
    const visibleBits = Math.min(before.length, after.length) * 8;
    const lastIndex = Math.min(leaf.count, firstVisibleIndex + Math.floor(visibleBits / leaf.bitsPer));

    for (let index = firstVisibleIndex; index < lastIndex; index++) {
        const from = valueAt(before, index);
        const to = valueAt(after, index);
        if (from === undefined || to === undefined || from === to) {
            continue;
        }
        rows.push({
            label: `${leaf.short}[${index}]`,
            detail: `${leaf.path}[${index}]`,
            text: `${from} → ${to}`,
            filled: true,
            internal: leaf.role === "internal",
            before: from,
            after: to,
            ...siteOf(index, from, to),
        });
    }

    return rows;
}

const groupOf = (site: RowSite) => `${site.containerPath}#${site.slot}`;

// A record is zeroed when its slot is vacated, so only an arriving entry still has its key in the after image; undefined means the window never carried it.
const labelKey = (site: EntrySite, flag: FlagSite | undefined) => (flag && flag.to !== 1 ? site.keyBefore : site.keyAfter);

// An entry that just arrived has a zero before image, so `= v` says more than `0 → v`; one that left keeps its arrow, since the value it held is what matters.
function entryText(site: EntrySite, flag: FlagSite | undefined): string {
    if (flag?.to === 1) {
        return `= ${site.after} (new)`;
    }
    if (flag?.to === 2) {
        return `${site.before} → (removed)`;
    }
    return `${site.before} → ${site.after}`;
}

// A record's rows all describe one entry, so they read as one line labelled by the key the contract wrote; the bucket stays on the full path.
function collapseEntries(rows: SitedRow[]): StateDiffLine[] {
    const flags = new Map<string, FlagSite>();
    const valued = new Set<string>();
    const keyRows = new Set<string>();
    const collapsed = new Set<string>();

    for (const { site } of rows) {
        if (site?.part === "flag") {
            flags.set(groupOf(site), site);
        } else if (site?.part === "value") {
            valued.add(groupOf(site));
        } else if (site?.part === "key") {
            keyRows.add(groupOf(site));
        }
    }

    for (const { site } of rows) {
        if (site?.part === "value" && labelKey(site, flags.get(groupOf(site))) !== undefined) {
            collapsed.add(groupOf(site));
        }
    }

    return rows.map(({ site, ...line }) => {
        if (!site) {
            return line;
        }

        const group = groupOf(site);

        if (site.part === "flag") {
            // An entry whose key and value both stayed zero left only its flag, which then names it.
            if (site.key !== undefined && !valued.has(group) && !keyRows.has(group)) {
                return { ...line, label: `${site.container}[${site.key}]`, text: site.to === 1 ? "(new)" : "(removed)", internal: false, change: changeOf(site) };
            }
            return line;
        }

        const flag = flags.get(group);
        const key = labelKey(site, flag);
        const labelled = key === undefined ? line.label : `${site.container}[${key}]${site.suffix}`;

        if (site.part === "value") {
            return key === undefined ? line : { ...line, label: labelled, text: entryText(site, flag), change: changeOf(flag) };
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

const changeOf = (flag: FlagSite | undefined): "new" | "removed" | undefined => (flag?.to === 1 ? "new" : flag?.to === 2 ? "removed" : undefined);

// A value straddling two regions can only be decoded once they are one range — core reports per dirty page, so a record crossing a page arrives split.
function joinedRegions(regions: DebugStateRegion[]): DebugStateRegion[] {
    const joined: DebugStateRegion[] = [];

    for (const region of [...regions].sort((left, right) => left.off - right.off)) {
        const last = joined[joined.length - 1];
        if (last && last.off + last.before.length / 2 === region.off) {
            last.before += region.before;
            last.after += region.after;
            continue;
        }

        joined.push({ ...region });
    }

    return joined;
}

// Every changed window, resolved and decoded. Regions may be minimal runs or aligned windows; a run not covering a whole value keeps its bytes.
export async function stateDiffLines(fields: StateField[], regions: DebugStateRegion[]): Promise<StateDiffLine[]> {
    const rows: SitedRow[] = [];

    for (const region of joinedRegions(regions)) {
        const before = hexToBytes(region.before);
        const after = hexToBytes(region.after);
        const windowEnd = region.off + Math.min(before.length, after.length);
        const slice = (bytes: Uint8Array, from: number, to: number) => bytes.slice(from - region.off, to - region.off);

        const keyText = async (bytes: Uint8Array, type: AbiType) => keyLabel(await decodeAbi(bytes, type), type);

        // The key labelling a record is read from the window, not the rows: an update leaves the key bytes alone, so it never produces a row of its own.
        const entrySiteOf = async (recordKey: ResolvedRecordKey, short: string): Promise<EntryBase | undefined> => {
            const keyEnd = recordKey.keyOff + recordKey.keyType.size;
            if (recordKey.keyOff < region.off || keyEnd > windowEnd) {
                return undefined;
            }

            return {
                part: recordKey.part,
                container: recordKey.container,
                containerPath: recordKey.containerPath,
                slot: recordKey.slot,
                suffix: short.slice(recordKey.member.length),
                keyBefore: await keyText(slice(before, recordKey.keyOff, keyEnd), recordKey.keyType),
                keyAfter: await keyText(slice(after, recordKey.keyOff, keyEnd), recordKey.keyType),
            };
        };

        // A flag that opened or closed an entry carries its key when the record is in the window — the only name an all-zero entry can ever get.
        const namedFlags = (flagged: SitedRow[], flagRecords: RecordKeyGeometry): Promise<SitedRow[]> =>
            Promise.all(
                flagged.map(async (row) => {
                    const site = row.site;
                    if (site?.part !== "flag" || (site.to !== 1 && site.to !== 2)) {
                        return row;
                    }
                    const keyStart = flagRecords.recordsOff + site.slot * flagRecords.stride + flagRecords.keyOff;
                    const keyEnd = keyStart + flagRecords.keyType.size;
                    if (keyStart < region.off || keyEnd > windowEnd) {
                        return row;
                    }
                    return { ...row, site: { ...site, key: await keyText(slice(site.to === 1 ? after : before, keyStart, keyEnd), flagRecords.keyType) } };
                }),
            );

        let stateOffset = region.off;

        while (stateOffset < windowEnd) {
            const field = fields.find((candidate) => stateOffset >= candidate.off && stateOffset < candidate.off + candidate.size);
            const unnamed = () => {
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
                        unnamed();
                    }
                    stateOffset = next.off;
                    continue;
                }

                // Past the last field, alignment slack and a region longer than the whole state look the same, and the second is worth saying.
                unnamed();
                break;
            }

            // A field with no ABI cannot be decoded at all, which is still a reason to stop.
            if (!field.abi) {
                unnamed();
                break;
            }

            const leaf = resolveLeaf(
                { path: field.name, short: field.name },
                field.off,
                field.abi,
                stateOffset - field.off,
                (off, size) => off >= region.off && off + size <= windowEnd,
            );

            if (leaf.kind === "bits") {
                // The whole flags run starts at `leaf.off`, which may be windows behind this one.
                const visibleStart = Math.max(leaf.off, region.off);
                const visibleEnd = Math.min(leaf.off + leaf.size, windowEnd);
                const firstVisibleIndex = ((visibleStart - leaf.off) * 8) / leaf.bitsPer;
                const entry = leaf.recordKey ? await entrySiteOf(leaf.recordKey, leaf.short) : undefined;
                const flagged = bitRows(leaf, slice(before, visibleStart, visibleEnd), slice(after, visibleStart, visibleEnd), firstVisibleIndex, entry);
                rows.push(...(leaf.flagRecords ? await namedFlags(flagged, leaf.flagRecords) : flagged));
                stateOffset = visibleEnd;
                continue;
            }

            const valueEnd = leaf.off + leaf.type.size;
            const visibleStart = Math.max(leaf.off, region.off);
            const visibleEnd = Math.min(valueEnd, windowEnd);
            const beforeBytes = slice(before, visibleStart, visibleEnd);
            const afterBytes = slice(after, visibleStart, visibleEnd);

            // A window carries unchanged bytes around the ones that moved; only the latter are worth a row.
            if (!bytesEqual(beforeBytes, afterBytes)) {
                const internal = leaf.role === "internal";
                if (leaf.off >= region.off && valueEnd <= windowEnd) {
                    const renderedBefore = await renderValue(beforeBytes, leaf.type);
                    const renderedAfter = await renderValue(afterBytes, leaf.type);
                    const change = `${renderedBefore.text} → ${renderedAfter.text}`;
                    const entry = leaf.recordKey ? await entrySiteOf(leaf.recordKey, leaf.short) : undefined;
                    const site = entry
                        ? { ...entry, before: renderedBefore.text, after: renderedAfter.text, beforeData: renderedBefore.data, afterData: renderedAfter.data }
                        : undefined;
                    rows.push({
                        label: leaf.short,
                        detail: leaf.path,
                        text: leaf.role === "count" ? `${change} entries` : change,
                        filled: true,
                        internal,
                        before: renderedBefore.data,
                        after: renderedAfter.data,
                        ...(site ? { site } : {}),
                    });
                } else {
                    // A partial run: report the bytes that did change rather than invent the ones that did not.
                    const inside = `+${visibleStart - leaf.off}`;
                    rows.push({
                        label: leaf.short + inside,
                        detail: leaf.path + inside,
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
