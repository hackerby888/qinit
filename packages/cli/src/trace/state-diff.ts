// Diffs read as fields/elements/members, not offsets and hex — container internals come from the member
// tables in @qinit/proto/qpi-layout.
import { decodeOutput } from "@qinit/proto";
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
import { formatStateValue, keyLabel, type StateField, type StateLine } from "./state-format";
import { hexToBytes } from "@qinit/core";

// A diff row keeps both label forms: `label` is what the default view shows, `detail` the full resolved
// path. `internal` marks container bookkeeping a contract author never wrote, hidden until the full view.
export type StateDiffLine = StateLine & { detail: string; internal: boolean };

// Container bookkeeping is not in the IDL — its indices and counters are plain 64-bit words.
const word = (kind: AbiScalarKind, size = 8): AbiType => ({
    kind: AbiTypeKind.SCALAR,
    scalar: kind,
    size,
    align: 8,
    format: kind,
});
const WORD_TYPES: Record<WordType, AbiType> = {
    sint64: word(AbiScalarKind.SINT64),
    uint64: word(AbiScalarKind.UINT64),
    id: word(AbiScalarKind.ID, 32),
};

// `payload` is a value the contract itself wrote, `count` a container's entry total, and `internal` the
// bookkeeping — occupation flags, list links, free-list heads — that only the full view shows.
type LeafClass = MemberRole;

// Two names per leaf: the resolved path through the container, and the shorter label the default view
// shows for it. They differ only where a path runs through container internals.
type Names = { path: string; short: string };

const child = (names: Names, suffix: string, shortSuffix = suffix): Names => ({
    path: names.path + suffix,
    short: names.short + shortSuffix,
});

// A record of a keyed container, with where its key sits so the row can be labelled by the key the
// contract wrote instead of the bucket the entry hashed into. `member` is the path the label replaces.
type KeyedLeaf = {
    part: "key" | "value";
    container: string;
    containerPath: string;
    slot: number;
    member: string;
    keyOff: number;
    keyType: AbiType;
};

// A decodable value at an absolute state offset, or packed bits to report one changed index at a time.
// `keyed` marks a value inside a keyed container's record, `owner` the flags run that says whether those
// records gained or lost an entry.
type Leaf = Names & { keyed?: KeyedLeaf; owner?: { container: string; containerPath: string } } & (
        | { kind: "value"; cls: LeafClass; off: number; type: AbiType }
        | {
              kind: "bits";
              cls: LeafClass;
              off: number;
              size: number;
              bitsPer: number;
              count: number;
          }
    );

// What a row contributes to its record's entry line. The value images are the rendered strings, and both
// key images are kept because whether the entry arrived or left is only known once its flag turns up —
// possibly from a window resolved later. None of this leaves the module.
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
};
type FlagSite = { part: "flag"; containerPath: string; slot: number; from: number; to: number };
type RowSite = EntrySite | FlagSite;

type SitedRow = StateDiffLine & { site?: RowSite };

const at = (names: Names, off: number, type: AbiType, cls: LeafClass = "payload"): Leaf => ({
    kind: "value",
    ...names,
    cls,
    off,
    type,
});

// The member of `type` that byte `offset` (relative to `base`) falls in. Indexed collections always
// resolve per element; a struct stops as one row when `covered` says the region holds all of it.
function leafAt(names: Names, base: number, type: AbiType, offset: number, covered: (off: number, size: number) => boolean): Leaf {
    switch (type.kind) {
        case AbiTypeKind.STRUCT: {
            if (covered(base, type.size)) {
                return at(names, base, type);
            }

            const field = type.fields.find((candidate) => offset >= candidate.offset && offset < candidate.offset + candidate.size);
            if (!field) {
                return at(names, base, type);
            }
            return leafAt(child(names, `.${field.name}`), base + field.offset, field.type, offset - field.offset, covered);
        }

        case AbiTypeKind.ARRAY: {
            const { stride } = arrayGeometry(type.element, type.count);
            const index = Math.floor(offset / stride);
            const inner = offset - index * stride;
            const element = child(names, `[${index}]`);
            const elementBase = base + index * stride;
            if (inner >= type.element.size) {
                return at(element, elementBase, type.element);
            }
            return leafAt(element, elementBase, type.element, inner, covered);
        }

        case AbiTypeKind.HASH_MAP:
            return memberLeaf(
                names,
                base,
                offset,
                hashMapMembers(type.key, type.value, type.capacity),
                (tag) => (tag === "key" ? type.key : type.value),
                covered,
            );

        case AbiTypeKind.HASH_SET:
            return memberLeaf(names, base, offset, hashSetMembers(type.key, type.capacity), () => type.key, covered);

        // Printing 256 bits twice to show one flip is the noise this whole module exists to remove.
        case AbiTypeKind.BIT_ARRAY:
            return bitsLeaf(names, base, type.size, 1, type.bitCount, "payload");

        case AbiTypeKind.COLLECTION:
            return memberLeaf(names, base, offset, collectionMembers(type.value, type.capacity), () => type.value, covered);

        case AbiTypeKind.LINKED_LIST:
            return memberLeaf(names, base, offset, linkedListMembers(type.value, type.capacity), () => type.value, covered);

        default:
            return at(names, base, type);
    }
}

// Matching takes the first member whose end passes the offset, so C padding belongs to the member that
// follows it and the leaf always ends past `offset` — what keeps stateDiffLines moving.
function memberLeaf(
    names: Names,
    base: number,
    offset: number,
    regions: ContainerRegion[],
    idlType: (tag: "key" | "value") => AbiType,
    covered: (off: number, size: number) => boolean,
): Leaf {
    const region = regions.find((candidate) => offset < candidate.end) ?? regions[regions.length - 1];
    // Only a keyed container has anything better to label a record by than the bucket it hashed into.
    const keyedContainer = regions.some((candidate) => candidate.kind === "records" && candidate.members.some((member) => member.type === "key"));

    if (region.kind === "flags") {
        const bits = bitsLeaf(child(names, region.path), base + region.off, region.end - region.off, region.bitsPer, region.count, "internal");
        return keyedContainer ? { ...bits, owner: { container: names.short, containerPath: names.path } } : bits;
    }

    if (region.kind === "word") {
        return at(child(names, region.path, region.short), base + region.off, WORD_TYPES[region.type], region.role);
    }

    const index = Math.floor((offset - region.off) / region.stride);
    const inner = offset - region.off - index * region.stride;
    const recordBase = base + region.off + index * region.stride;
    const record = child(names, `${region.path}[${index}]`, `${region.short}[${index}]`);

    const found = region.members.find((candidate) => inner < candidate.off + candidate.size);
    if (!found) {
        // Trailing pad after a record's last member names nothing. A zero-count bits leaf reports no row and
        // still moves the walk past the rest of the record, which reading the pad as a word did not.
        return bitsLeaf(record, recordBase + inner, region.stride - inner, 1, 0, "internal");
    }

    const named = child(record, found.path, found.short);
    if (found.type !== "key" && found.type !== "value") {
        return at(named, recordBase + found.off, WORD_TYPES[found.type], found.role);
    }

    const leaf = leafAt(named, recordBase + found.off, idlType(found.type), Math.max(0, inner - found.off), covered);
    const keyMember = region.members.find((candidate) => candidate.type === "key");
    if (!keyMember) {
        return leaf;
    }

    return {
        ...leaf,
        keyed: {
            part: found.type,
            container: names.short,
            containerPath: names.path,
            slot: index,
            member: named.short,
            keyOff: recordBase + keyMember.off,
            keyType: idlType("key"),
        },
    };
}

const bitsLeaf = (names: Names, off: number, size: number, bitsPer: number, count: number, cls: LeafClass): Leaf => ({
    kind: "bits",
    ...names,
    cls,
    off,
    size,
    bitsPer,
    count,
});

const allZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);
const bytesEqual = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function renderValue(bytes: Uint8Array, type: AbiType): Promise<string> {
    if (allZero(bytes)) {
        return "0"; // matches how `qinit state` collapses an untouched element
    }

    const decoded = await decodeOutput(bytes, type);
    return typeof decoded === "object" && decoded !== null ? formatStateValue(decoded, type, true, true) : String(decoded);
}

// Occupation flags and BitArrays are packed, so report the indices that moved, not the raw words.
// `firstIndex` is the index the visible slice starts at, so a window opening inside the flags reports too.
function bitRows(leaf: Extract<Leaf, { kind: "bits" }>, before: Uint8Array, after: Uint8Array, firstIndex: number): SitedRow[] {
    const rows: SitedRow[] = [];
    const valueAt = (bytes: Uint8Array, index: number) => {
        const bit = (index - firstIndex) * leaf.bitsPer;
        const byte = bytes[bit >> 3];
        if (byte === undefined) {
            return undefined;
        }
        const mask = (1 << leaf.bitsPer) - 1;
        return (byte >> (bit & 7)) & mask;
    };

    // The slice only covers a bounded run of indices. Without this the loop walks the whole capacity and
    // only `valueAt`'s bounds check keeps it quiet — 33M no-op turns per window on a 536 MB map.
    const visibleBits = Math.min(before.length, after.length) * 8;
    const lastIndex = Math.min(leaf.count, firstIndex + Math.floor(visibleBits / leaf.bitsPer));

    for (let index = firstIndex; index < lastIndex; index++) {
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
            internal: leaf.cls === "internal",
            ...(leaf.owner ? { site: { part: "flag" as const, containerPath: leaf.owner.containerPath, slot: index, from, to } } : {}),
        });
    }

    return rows;
}

const groupOf = (site: RowSite) => `${site.containerPath}#${site.slot}`;

// A record is zeroed when its slot is vacated, so only an entry that arrived still has its key in the
// after image. Undefined means the window never carried the key, and the row stays as it was resolved.
const labelKey = (site: EntrySite, flag: FlagSite | undefined) => (flag && flag.to !== 1 ? site.keyBefore : site.keyAfter);

// An entry that just arrived has a zero before image, so `= v` says more than `0 → v` does; one that left
// keeps its arrow, because the value it was holding is the part worth reading.
function entryText(site: EntrySite, flag: FlagSite | undefined): string {
    if (flag?.to === 1) {
        return `= ${site.after} (new)`;
    }
    if (flag?.to === 2) {
        return `${site.before} → (removed)`;
    }
    return `${site.before} → ${site.after}`;
}

// A record's rows all describe one entry, so they read as one line labelled by the key the contract wrote.
// The bucket the entry hashed into stays on the full path, which is where an implementation detail belongs.
function collapseEntries(rows: SitedRow[]): StateDiffLine[] {
    const flags = new Map<string, FlagSite>();
    const valued = new Set<string>();
    const collapsed = new Set<string>();

    for (const { site } of rows) {
        if (site?.part === "flag") {
            flags.set(groupOf(site), site);
        } else if (site?.part === "value") {
            valued.add(groupOf(site));
        }
    }

    for (const { site } of rows) {
        if (site?.part === "value" && labelKey(site, flags.get(groupOf(site))) !== undefined) {
            collapsed.add(groupOf(site));
        }
    }

    return rows.map(({ site, ...line }) => {
        if (!site || site.part === "flag") {
            return line;
        }

        const group = groupOf(site);
        const flag = flags.get(group);
        const key = labelKey(site, flag);
        const labelled = key === undefined ? line.label : `${site.container}[${key}]${site.suffix}`;

        if (site.part === "value") {
            return key === undefined ? line : { ...line, label: labelled, text: entryText(site, flag) };
        }

        // The entry line already names the key, so a key row of its own is noise — unless nothing else
        // carries the entry, which is what a value that was and stays zero leaves behind.
        if (collapsed.has(group)) {
            return { ...line, internal: true };
        }
        if (valued.has(group) || !flag || key === undefined) {
            return line;
        }
        return { ...line, label: labelled, text: flag.to === 1 ? "(new)" : flag.to === 2 ? "(removed)" : line.text };
    });
}

// A value straddling two regions can only be decoded once they are one range — core reports per dirty
// page, so a record crossing a page boundary arrives split.
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

// Every changed window, resolved and decoded. Regions may be minimal runs (a core node) or aligned
// windows (the simulator); a run that does not cover a whole value keeps its bytes rather than guessing.
export async function stateDiffLines(fields: StateField[], regions: DebugStateRegion[]): Promise<StateDiffLine[]> {
    const rows: SitedRow[] = [];

    for (const region of joinedRegions(regions)) {
        const before = hexToBytes(region.before);
        const after = hexToBytes(region.after);
        const end = region.off + Math.min(before.length, after.length);
        const slice = (bytes: Uint8Array, from: number, to: number) => bytes.slice(from - region.off, to - region.off);

        // The key labelling a record is read from the window rather than from the rows: an update leaves the
        // key bytes alone, so it never produces a row of its own.
        const entrySiteOf = async (keyed: KeyedLeaf, short: string, valueBefore: string, valueAfter: string): Promise<EntrySite | undefined> => {
            const keyEnd = keyed.keyOff + keyed.keyType.size;
            if (keyed.keyOff < region.off || keyEnd > end) {
                return undefined;
            }
            const rendered = async (bytes: Uint8Array) => keyLabel(await decodeOutput(bytes, keyed.keyType), keyed.keyType);

            return {
                part: keyed.part,
                container: keyed.container,
                containerPath: keyed.containerPath,
                slot: keyed.slot,
                suffix: short.slice(keyed.member.length),
                keyBefore: await rendered(slice(before, keyed.keyOff, keyEnd)),
                keyAfter: await rendered(slice(after, keyed.keyOff, keyEnd)),
                before: valueBefore,
                after: valueAfter,
            };
        };

        let position = region.off;

        while (position < end) {
            const field = fields.find((candidate) => position >= candidate.off && position < candidate.off + candidate.size);
            const unnamed = () => {
                rows.push({
                    label: `@${position}`,
                    detail: `@${position}`,
                    text: "(outside any known field)",
                    filled: false,
                    internal: false,
                });
            };

            if (!field) {
                const next = fields.find((candidate) => candidate.off > position);

                // Alignment padding between two fields belongs to neither, so step over it. Stopping here
                // drops every later row in the window, and the bytes are only worth a row if they moved.
                if (next && next.off < end) {
                    if (!bytesEqual(slice(before, position, next.off), slice(after, position, next.off))) {
                        unnamed();
                    }
                    position = next.off;
                    continue;
                }

                // Past the last field, alignment slack and a region longer than the whole state look the
                // same from here, and the second is worth saying out loud.
                unnamed();
                break;
            }

            // A field with no ABI cannot be decoded at all, which is still a reason to stop.
            if (!field.abi) {
                unnamed();
                break;
            }

            const leaf = leafAt(
                { path: field.name, short: field.name },
                field.off,
                field.abi,
                position - field.off,
                (off, size) => off >= region.off && off + size <= end,
            );

            if (leaf.kind === "bits") {
                // The whole flags run starts at `leaf.off`, which may be windows behind this one.
                const visibleStart = Math.max(leaf.off, region.off);
                const visibleEnd = Math.min(leaf.off + leaf.size, end);
                const firstIndex = ((visibleStart - leaf.off) * 8) / leaf.bitsPer;
                rows.push(...bitRows(leaf, slice(before, visibleStart, visibleEnd), slice(after, visibleStart, visibleEnd), firstIndex));
                position = visibleEnd;
                continue;
            }

            const valueEnd = leaf.off + leaf.type.size;
            const visibleStart = Math.max(leaf.off, region.off);
            const visibleEnd = Math.min(valueEnd, end);
            const beforeBytes = slice(before, visibleStart, visibleEnd);
            const afterBytes = slice(after, visibleStart, visibleEnd);

            // A window carries unchanged bytes around the ones that moved; only the latter are worth a row.
            if (!bytesEqual(beforeBytes, afterBytes)) {
                const internal = leaf.cls === "internal";
                if (leaf.off >= region.off && valueEnd <= end) {
                    const renderedBefore = await renderValue(beforeBytes, leaf.type);
                    const renderedAfter = await renderValue(afterBytes, leaf.type);
                    const change = `${renderedBefore} → ${renderedAfter}`;
                    const site = leaf.keyed ? await entrySiteOf(leaf.keyed, leaf.short, renderedBefore, renderedAfter) : undefined;
                    rows.push({
                        label: leaf.short,
                        detail: leaf.path,
                        text: leaf.cls === "count" ? `${change} entries` : change,
                        filled: true,
                        internal,
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
                    });
                }
            }

            position = Math.max(valueEnd, position + 1);
        }
    }

    return collapseEntries(rows);
}
