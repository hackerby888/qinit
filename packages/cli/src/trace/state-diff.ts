// Diffs read as fields/elements/members, not offsets and hex — container internals come from the member tables in @qinit/proto/qpi-layout.
import { decodeAbi, decodeAbiValue, decodedAbiToJson } from "@qinit/proto";
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
import { holdsContainer, keyLabel, pastCapacityWarning, scalarText, type StateField, type StateLine } from "./state-format";
import { hexToBytes } from "@qinit/core";

// A diff row keeps both label forms: `label` for the default view, `detail` the full path; `internal` marks container bookkeeping hidden until the full view.
// `keyUnresolved`: entry unnamed, label fell back to the bucket index. `pastCapacity`: the BitArray's declared size, on a bit the row's index lies beyond.
export type StateDiffLine = StateLine & {
    detail: string;
    internal: boolean;
    before?: unknown;
    after?: unknown;
    change?: "new" | "removed";
    keyUnresolved?: boolean;
    pastCapacity?: number;
};

// Reads a record's key from the node when no window carries it. Only a value update gets here.
export type StateKeyReader = (off: number, size: number) => Promise<Uint8Array | undefined>;

// Three stages: find what moved in each window, decode those bytes and look up the keys, then render every row once with its container entry known.
// (the IDL's state fields, the engine's changed windows, a key reader for the node) -> one row per change, named by field, element or entry.
export async function stateDiffLines(fields: StateField[], changedWindows: DebugStateRegion[], readKey?: StateKeyReader): Promise<StateDiffLine[]> {
    const windows = changedWindowsOf(changedWindows);
    const changes = windows.flatMap((window) => findChanges(fields, window));
    const decoded = await decodeChanges(changes, windows, readKey);
    return renderRows(decoded);
}

// Two names per change, the same pair a row carries: `detail` the resolved path through the container, `label` the shorter default view.
// They differ only where a path runs through container internals.
type Names = { detail: string; label: string };

// Extends both names one level deeper, e.g. `balances` + `.slot[3]`; the label suffix differs only inside container internals.
const descend = (names: Names, detailSuffix: string, labelSuffix = detailSuffix): Names => ({
    detail: names.detail + detailSuffix,
    label: names.label + labelSuffix,
});

// One changed window with its images decoded from hex, read to the shorter image when the two differ in length.
type ChangedWindow = { start: number; end: number; before: Uint8Array; after: Uint8Array };
type ImagePair = { before: Uint8Array; after: Uint8Array };
type Rendered = { text: string; data: unknown };

// The container entry a change belongs to: which part of which slot (with the path below the member), and where the key that names it sits.
type EntryRef = { part: "key" | "value" | "flag"; container: Names; slot: number; suffix: string; keyStart: number; keyType: AbiType };

// The entry's key once looked up: both images when a window holds it, or the live key read back from the node for an update.
type EntryKey = { before: string; after: string } | { fetched: string };

// What stage one finds in a window, and what stage two hands on: the same change with bytes turned into text and its entry's key looked up.
type ChangeOf<Value, Entry> =
    | { kind: "value"; names: Names; role: MemberRole; value: Value; entry?: Entry }
    | { kind: "partial"; names: Names; role: MemberRole; offsetInValue: number; bytes: ImagePair }
    | { kind: "bit"; names: Names; role: MemberRole; from: number; to: number; pastCapacity?: number; entry?: Entry }
    | { kind: "unknown"; stateOffset: number };
type Change = ChangeOf<ImagePair & { type: AbiType }, EntryRef>;
type DecodedChange = ChangeOf<{ before: Rendered; after: Rendered }, EntryRef & { key?: EntryKey }>;

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

// A value straddling two windows can only be decoded once they are one range — core reports per dirty page, so a record crossing a page arrives split.
// Only exactly-adjacent runs merge; the `/ 2` is because the images are hex.
function changedWindowsOf(changedWindows: DebugStateRegion[]): ChangedWindow[] {
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

    return joined.map((changedWindow) => {
        const before = hexToBytes(changedWindow.before);
        const after = hexToBytes(changedWindow.after);
        return { start: changedWindow.off, end: changedWindow.off + Math.min(before.length, after.length), before, after };
    });
}

// Whether the window holds all of an absolute range.
const covers = (window: ChangedWindow, start: number, size: number) => start >= window.start && start + size <= window.end;

// Whether an absolute range and the window share any byte.
const overlaps = (window: ChangedWindow, start: number, size: number) => start < window.end && start + size > window.start;

// An absolute state range as a slice of one of the window's images.
const imageSlice = (window: ChangedWindow, image: Uint8Array, start: number, end: number) => image.slice(start - window.start, end - window.start);

// An absolute range from whichever window holds all of it on that side; only adjacent windows merge, so it may be a sibling of the window being read.
function imageAt(windows: ChangedWindow[], side: "before" | "after", start: number, size: number): Uint8Array | undefined {
    for (const window of windows) {
        const image = window[side];
        const offset = start - window.start;
        if (offset >= 0 && offset + size <= image.length) {
            return image.slice(offset, offset + size);
        }
    }
    return undefined;
}

const allZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);
const bytesEqual = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);
const toHex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Stage one: what moved. The walk visits only the parts of each type that share a byte with the window and compares them in place; padding is never visited.

type Walk = { window: ChangedWindow; changes: Change[] };
type RecordsRegion = Extract<ContainerRegion, { kind: "records" }>;

// The keyed record a walk is inside: which of its members and where its key sits, so every payload change beneath can be named by the entry.
type RecordScope = { part: "key" | "value"; container: Names; slot: number; member: string; keyStart: number; keyType: AbiType };

// A packed run: `indexCount` entries of `bitsPerIndex` bits from an absolute state offset.
// `capacity` set only when the run stores more indices than the container holds, as a small BitArray's last word does.
type BitRun = { start: number; size: number; bitsPerIndex: number; indexCount: number; capacity?: number };

// The first and last index of a strided run that share a byte with the window — a 545 MB map's records or flags are never walked whole.
function visibleIndices(window: ChangedWindow, start: number, stride: number, count: number): [number, number] {
    const first = Math.max(0, Math.floor((window.start - start) / stride));
    const last = Math.min(count - 1, Math.floor((window.end - 1 - start) / stride));
    return [first, last];
}

// The entry a change under `scope` belongs to; the path below the member is what the leaf's label adds to the member's.
const entryOf = (scope: RecordScope, label: string): EntryRef => ({
    part: scope.part,
    container: scope.container,
    slot: scope.slot,
    suffix: label.slice(scope.member.length),
    keyStart: scope.keyStart,
    keyType: scope.keyType,
});

// Windows may be minimal runs or aligned pages; a run not covering a whole value keeps its bytes.
// (the IDL's state fields, one window) -> what moved in it, in state order.
function findChanges(fields: StateField[], window: ChangedWindow): Change[] {
    const walk: Walk = { window, changes: [] };
    const moved = (start: number, end: number) => !bytesEqual(imageSlice(window, window.before, start, end), imageSlice(window, window.after, start, end));
    let cursor = window.start;

    for (const field of fields) {
        if (field.off + field.size <= cursor) {
            continue;
        }

        // Alignment padding between two fields belongs to neither; a byte that moved there is worth a row, and the walk goes on past it.
        const gapEnd = Math.min(field.off, window.end);
        if (gapEnd > cursor) {
            if (moved(cursor, gapEnd)) {
                walk.changes.push({ kind: "unknown", stateOffset: cursor });
            }
            cursor = gapEnd;
        }
        if (cursor >= window.end) {
            return walk.changes;
        }

        // A field with no ABI cannot be decoded at all, which is still a reason to stop.
        if (!field.abi) {
            walk.changes.push({ kind: "unknown", stateOffset: cursor });
            return walk.changes;
        }

        walkType(walk, { detail: field.name, label: field.name }, field.off, field.abi);
        cursor = field.off + field.size;
        if (cursor >= window.end) {
            return walk.changes;
        }
    }

    // Past the last field is alignment slack every window reaches; report it only when it moved.
    if (moved(cursor, window.end)) {
        walk.changes.push({ kind: "unknown", stateOffset: cursor });
    }
    return walk.changes;
}

// The parts of `type` the window touches. Indexed collections walk per element; a struct without a container that the window holds whole is one value.
// (names, absolute start of `type`, `type`, the keyed record it sits in) -> changes pushed onto the walk.
function walkType(walk: Walk, names: Names, start: number, type: AbiType, scope?: RecordScope): void {
    const { window } = walk;

    switch (type.kind) {
        case AbiTypeKind.STRUCT: {
            // A struct holding a container is never one row: the container's members say what moved.
            if (!holdsContainer(type) && covers(window, start, type.size)) {
                compareValue(walk, names, start, type, "payload", scope);
                return;
            }

            for (const field of type.fields) {
                if (overlaps(window, start + field.offset, field.size)) {
                    walkType(walk, descend(names, `.${field.name}`), start + field.offset, field.type, scope);
                }
            }
            return;
        }

        case AbiTypeKind.ARRAY: {
            const { stride } = arrayGeometry(type.element, type.count);
            const [first, last] = visibleIndices(window, start, stride, type.count);
            for (let index = first; index <= last; index++) {
                walkType(walk, descend(names, `[${index}]`), start + index * stride, type.element, scope);
            }
            return;
        }

        // Printing 256 bits twice to show one flip is the noise this whole module exists to remove.
        case AbiTypeKind.BIT_ARRAY: {
            const entry = scope && entryOf(scope, names.label);
            const entryAt = entry && ((index: number) => ({ ...entry, suffix: `${entry.suffix}[${index}]` }));
            // the whole storage word, not just bitCount: core's set(i) only masks the word index, so a small BitArray's tail bits are writable.
            const run = { start, size: type.size, bitsPerIndex: 1, indexCount: type.size * 8, capacity: type.bitCount };
            compareBits(walk, names, run, "payload", entryAt);
            return;
        }

        case AbiTypeKind.HASH_MAP:
            walkContainer(walk, names, start, hashMapMembers(type.key, type.value, type.capacity), (tag) => (tag === "key" ? type.key : type.value), scope);
            return;

        case AbiTypeKind.HASH_SET:
            walkContainer(walk, names, start, hashSetMembers(type.key, type.capacity), () => type.key, scope);
            return;

        case AbiTypeKind.COLLECTION:
            walkContainer(walk, names, start, collectionMembers(type.value, type.capacity), () => type.value, scope);
            return;

        case AbiTypeKind.LINKED_LIST:
            walkContainer(walk, names, start, linkedListMembers(type.value, type.capacity), () => type.value, scope);
            return;

        default:
            compareValue(walk, names, start, type, "payload", scope);
    }
}

// Each container region the window touches: records by index, a flags run by bit, the counters as words.
// (names, container's absolute start, its qpi-layout regions, the IDL type behind `key`/`value`, the keyed record it sits in) -> changes pushed onto the walk.
function walkContainer(
    walk: Walk,
    names: Names,
    start: number,
    layout: ContainerRegion[],
    idlType: (tag: "key" | "value") => AbiType,
    scope?: RecordScope,
): void {
    const { window } = walk;
    // Only a keyed container has anything better to label a record by than the bucket it hashed into.
    const records = layout.find((candidate): candidate is RecordsRegion => candidate.kind === "records");
    const keyMember = records?.members.find((candidate) => candidate.type === "key");

    for (const region of layout) {
        if (!overlaps(window, start + region.off, region.end - region.off)) {
            continue;
        }

        switch (region.kind) {
            case "records":
                walkRecords(walk, names, start + region.off, region, idlType, scope);
                break;

            case "flags": {
                // A flag that opened or closed an entry is named by that entry's key — the only name an all-zero entry can ever get.
                const flagAt =
                    records && keyMember
                        ? (slot: number): EntryRef => ({
                              part: "flag",
                              container: names,
                              slot,
                              suffix: "",
                              keyStart: start + records.off + slot * records.stride + keyMember.off,
                              keyType: idlType("key"),
                          })
                        : undefined;
                const run = { start: start + region.off, size: region.end - region.off, bitsPerIndex: region.bitsPer, indexCount: region.count };
                compareBits(walk, descend(names, region.path), run, "internal", flagAt);
                break;
            }

            case "word":
                compareValue(walk, descend(names, region.path, region.short), start + region.off, WORD_TYPES[region.type], region.role);
                break;
        }
    }
}

// The records the window touches, member by member; a key or value member is walked as its IDL type inside the record's scope.
// A nested container's payload keeps the outer entry's key, its bookkeeping words and flags stay its own.
// (container names, absolute start of the records, the region, the IDL type behind `key`/`value`, the enclosing keyed record) -> changes pushed onto the walk.
function walkRecords(walk: Walk, names: Names, start: number, region: RecordsRegion, idlType: (tag: "key" | "value") => AbiType, outer?: RecordScope): void {
    const { window } = walk;
    const keyMember = region.members.find((candidate) => candidate.type === "key");
    const [first, last] = visibleIndices(window, start, region.stride, (region.end - region.off) / region.stride);

    for (let index = first; index <= last; index++) {
        const recordStart = start + index * region.stride;
        const record = descend(names, `${region.path}[${index}]`, `${region.short}[${index}]`);

        for (const member of region.members) {
            if (!overlaps(window, recordStart + member.off, member.size)) {
                continue;
            }

            // qpi-layout spells the same pair `path`/`short`, so this is where its vocabulary meets this module's `detail`/`label`.
            const named = descend(record, member.path, member.short);
            if (member.type !== "key" && member.type !== "value") {
                compareValue(walk, named, recordStart + member.off, WORD_TYPES[member.type], member.role);
                continue;
            }

            const own = keyMember && {
                part: member.type,
                container: names,
                slot: index,
                member: named.label,
                keyStart: recordStart + keyMember.off,
                keyType: idlType("key"),
            };
            walkType(walk, named, recordStart + member.off, idlType(member.type), outer ?? own);
        }
    }
}

// (names, the value's absolute start, its type) -> a `value` change when the window holds all of it, a `partial` one when the window cuts it, nothing when the bytes match.
function compareValue(walk: Walk, names: Names, start: number, type: AbiType, role: MemberRole, scope?: RecordScope): void {
    const { window } = walk;
    const visibleStart = Math.max(start, window.start);
    const visibleEnd = Math.min(start + type.size, window.end);
    const bytes = { before: imageSlice(window, window.before, visibleStart, visibleEnd), after: imageSlice(window, window.after, visibleStart, visibleEnd) };

    // A window carries unchanged bytes around the ones that moved; only the latter are worth a row.
    if (bytesEqual(bytes.before, bytes.after)) {
        return;
    }

    if (covers(window, start, type.size)) {
        walk.changes.push({ kind: "value", names, role, value: { ...bytes, type }, entry: scope && entryOf(scope, names.label) });
    } else {
        // A partial run: report the bytes that did change rather than invent the ones that did not.
        walk.changes.push({ kind: "partial", names, role, offsetInValue: visibleStart - start, bytes });
    }
}

// Occupation flags and BitArrays are packed, so report the indices that moved, not the raw words.
// (names, the packed run, the entry each index belongs to) -> one `bit` change per visible index whose value moved.
function compareBits(walk: Walk, names: Names, run: BitRun, role: MemberRole, entryAt?: (index: number) => EntryRef): void {
    const { window } = walk;
    // The whole run may start windows behind this one; only its visible slice is read.
    const visibleStart = Math.max(run.start, window.start);
    const visibleEnd = Math.min(run.start + run.size, window.end);
    const before = imageSlice(window, window.before, visibleStart, visibleEnd);
    const after = imageSlice(window, window.after, visibleStart, visibleEnd);
    const firstVisibleIndex = ((visibleStart - run.start) * 8) / run.bitsPerIndex;
    const valueAt = (bytes: Uint8Array, index: number) => {
        const bit = (index - firstVisibleIndex) * run.bitsPerIndex;
        const byte = bytes[bit >> 3];
        if (byte === undefined) {
            return undefined;
        }
        const mask = (1 << run.bitsPerIndex) - 1;
        return (byte >> (bit & 7)) & mask;
    };

    // The slice only covers a bounded run of indices; without this the loop walks the whole capacity — 33M no-op turns per window on a 536 MB map.
    const visibleBits = Math.min(before.length, after.length) * 8;
    const lastIndex = Math.min(run.indexCount, firstVisibleIndex + Math.floor(visibleBits / run.bitsPerIndex));

    for (let index = firstVisibleIndex; index < lastIndex; index++) {
        const from = valueAt(before, index);
        const to = valueAt(after, index);
        if (from === undefined || to === undefined || from === to) {
            continue;
        }
        const pastCapacity = run.capacity !== undefined && index >= run.capacity ? run.capacity : undefined;
        walk.changes.push({ kind: "bit", names: descend(names, `[${index}]`), role, from, to, pastCapacity, entry: entryAt?.(index) });
    }
}

// Stage two: bytes to text, the only step that decodes, and the only one that may ask the node for anything.

// Bytes + type -> display text and JSON data, e.g. `07 00 …` as uint64 -> `{ text: "7", data: 7n }`; an all-zero value collapses to `0`.
async function renderValue(bytes: Uint8Array, type: AbiType): Promise<Rendered> {
    const decoded = await decodeAbi(bytes, type);
    const data = decodedAbiToJson(decoded, type);
    if (allZero(bytes)) {
        return { text: "0", data }; // matches how `qinit state` collapses an untouched element
    }

    return { text: scalarText(decoded, type), data };
}

// Key bytes -> the label text an entry is named by, the same text `qinit state` prints. `decodeAbiValue` keeps a one-field struct positional; `decodeAbi` would unwrap it.
const keyText = async (bytes: Uint8Array, type: AbiType) => keyLabel(await decodeAbiValue(bytes, type), type);

// (the changes, every window of the diff, the node's key reader) -> the same changes with values rendered and each entry's key looked up.
async function decodeChanges(changes: Change[], windows: ChangedWindow[], readKey?: StateKeyReader): Promise<DecodedChange[]> {
    // One read per distinct key, however many rows ask for it.
    const fetched = new Map<string, Promise<Uint8Array | undefined>>();
    const fetchKey = (off: number, size: number) => {
        const at = `${off}:${size}`;
        let pending = fetched.get(at);
        if (!pending) {
            pending = readKey!(off, size);
            fetched.set(at, pending);
        }
        return pending;
    };

    // The key is read from the diff, not the rows: an update leaves the key bytes alone, so they never produce a row of their own, and they may sit in a sibling window.
    // In no window at all means this dispatch never touched it, so the node still holds it — except for a flag, since a record that left reads back as zeros.
    const keyOf = async (entry: EntryRef): Promise<EntryKey | undefined> => {
        const size = entry.keyType.size;
        const before = imageAt(windows, "before", entry.keyStart, size);
        const after = imageAt(windows, "after", entry.keyStart, size);
        if (before && after) {
            return { before: await keyText(before, entry.keyType), after: await keyText(after, entry.keyType) };
        }
        if (entry.part === "flag" || !readKey) {
            return undefined;
        }
        const live = await fetchKey(entry.keyStart, size);
        return live && { fetched: await keyText(live, entry.keyType) };
    };

    const decoded: DecodedChange[] = [];

    for (const change of changes) {
        if (change.kind === "value") {
            const value = {
                before: await renderValue(change.value.before, change.value.type),
                after: await renderValue(change.value.after, change.value.type),
            };
            decoded.push({ ...change, value, entry: change.entry && { ...change.entry, key: await keyOf(change.entry) } });
        } else if (change.kind === "bit") {
            decoded.push({ ...change, entry: change.entry && { ...change.entry, key: await keyOf(change.entry) } });
        } else {
            decoded.push(change);
        }
    }

    return decoded;
}

// Stage three: rows. A record's changes all describe one entry, so they read as one line labelled by the key the contract wrote; the bucket stays on the full path.

// What the other rows of an entry say about it: the flag that opened or closed the slot, and which record parts have a row that found its key.
type EntryFacts = { flag?: { to: number }; hasKeyRow: boolean; hasValueRow: boolean; namedByValue: boolean };
type DecodedEntry = EntryRef & { key?: EntryKey };

// The map key tying every change of one container entry together: container path + slot.
const groupOf = (entry: EntryRef) => `${entry.container.detail}#${entry.slot}`;

// A flag's new value as the row's change kind: 1 -> new, 2 -> removed, anything else -> undefined.
const changeOf = (flag: { to: number } | undefined): "new" | "removed" | undefined => (flag?.to === 1 ? "new" : flag?.to === 2 ? "removed" : undefined);

// The key an entry's rows are named by. A record is zeroed when its slot is vacated, so only an arriving entry still has its key in the after image,
// and a key read back after a removal is those zeros — refused, so the row falls back to the bucket rather than naming a lie.
function namingKey(key: EntryKey, flag: EntryFacts["flag"]): string | undefined {
    if ("fetched" in key) {
        return flag?.to === 2 ? undefined : key.fetched;
    }
    return flag && flag.to !== 1 ? key.before : key.after;
}

// An entry that just arrived has a zero before image, so `= v` says more than `0 → v`; one that left keeps its arrow, since the value it held is what matters.
function entryText(before: string, after: string, flag: EntryFacts["flag"]): string {
    if (flag?.to === 1) {
        return `= ${after} (new)`;
    }
    if (flag?.to === 2) {
        return `${before} → (removed)`;
    }
    return `${before} → ${after}`;
}

function entriesOf(decoded: DecodedChange[]): Map<string, EntryFacts> {
    const entries = new Map<string, EntryFacts>();
    const factsOf = (entry: EntryRef) => {
        const group = groupOf(entry);
        const facts = entries.get(group) ?? { hasKeyRow: false, hasValueRow: false, namedByValue: false };
        entries.set(group, facts);
        return facts;
    };

    const entryRows = decoded.flatMap((change) =>
        (change.kind === "value" || change.kind === "bit") && change.entry ? [{ change, entry: change.entry }] : [],
    );

    // Flags first: whether a value row can name its entry depends on the flag, so that question comes second.
    for (const { change, entry } of entryRows) {
        if (entry.part === "flag" && change.kind === "bit") {
            factsOf(entry).flag = { to: change.to };
        } else if (entry.key && entry.part === "value") {
            factsOf(entry).hasValueRow = true;
        } else if (entry.key && entry.part === "key") {
            factsOf(entry).hasKeyRow = true;
        }
    }
    for (const { entry } of entryRows) {
        if (entry.part === "value" && entry.key && namingKey(entry.key, factsOf(entry).flag) !== undefined) {
            factsOf(entry).namedByValue = true;
        }
    }

    return entries;
}

// A key or value row of a record, named by the entry's key; `before`/`after` are the row's own images as text.
function recordRow(physical: StateDiffLine, entry: DecodedEntry, before: string, after: string, facts: EntryFacts): StateDiffLine {
    const key = entry.key && namingKey(entry.key, facts.flag);
    if (key === undefined) {
        // Keyed record, key not found: the label is the bucket, not an identity, and the row says so.
        return entry.part === "value" ? { ...physical, keyUnresolved: true } : physical;
    }

    const label = `${entry.container.label}[${key}]${entry.suffix}`;
    if (entry.part === "value") {
        return { ...physical, label, text: entryText(before, after, facts.flag), change: changeOf(facts.flag) };
    }

    // The entry line already names the key, so a key row is noise — unless nothing else carries the entry, as with a value that was and stays zero.
    if (facts.namedByValue) {
        return { ...physical, internal: true };
    }
    if (facts.hasValueRow || !facts.flag) {
        return physical;
    }
    return { ...physical, label, text: facts.flag.to === 1 ? "(new)" : facts.flag.to === 2 ? "(removed)" : physical.text, change: changeOf(facts.flag) };
}

// A flag row stays bookkeeping unless it is all the entry left behind: a key and value that both stayed zero write no row of their own.
function flagRow(physical: StateDiffLine, entry: DecodedEntry, to: number, facts: EntryFacts): StateDiffLine {
    const key = entry.key && !("fetched" in entry.key) ? (to === 1 ? entry.key.after : to === 2 ? entry.key.before : undefined) : undefined;
    if (key === undefined || facts.hasValueRow || facts.hasKeyRow) {
        return physical;
    }
    return { ...physical, label: `${entry.container.label}[${key}]`, text: to === 1 ? "(new)" : "(removed)", internal: false, change: changeOf({ to }) };
}

// One decoded change -> its final row; a change inside a container record is named by its entry here and nowhere else.
function rowOf(change: DecodedChange, entries: Map<string, EntryFacts>): StateDiffLine {
    const facts = (entry: EntryRef) => entries.get(groupOf(entry)) ?? { hasKeyRow: false, hasValueRow: false, namedByValue: false };

    switch (change.kind) {
        case "unknown":
            return { label: `@${change.stateOffset}`, detail: `@${change.stateOffset}`, text: "(outside any known field)", filled: false, internal: false };

        case "partial": {
            const inside = `+${change.offsetInValue}`;
            const before = `0x${toHex(change.bytes.before)}`;
            const after = `0x${toHex(change.bytes.after)}`;
            return {
                label: change.names.label + inside,
                detail: change.names.detail + inside,
                text: `${before} → ${after}`,
                filled: true,
                internal: change.role === "internal",
                before,
                after,
            };
        }

        case "bit": {
            const physical = {
                label: change.names.label,
                detail: change.names.detail,
                text: `${change.from} → ${change.to}`,
                filled: true,
                internal: change.role === "internal",
                before: change.from,
                after: change.to,
            };
            const marked = (row: StateDiffLine) =>
                change.pastCapacity === undefined
                    ? row
                    : { ...row, text: `${row.text} (past capacity ${change.pastCapacity})`, pastCapacity: change.pastCapacity };
            if (!change.entry) {
                return marked(physical);
            }
            return marked(
                change.entry.part === "flag"
                    ? flagRow(physical, change.entry, change.to, facts(change.entry))
                    : recordRow(physical, change.entry, String(change.from), String(change.to), facts(change.entry)),
            );
        }

        case "value": {
            const text = `${change.value.before.text} → ${change.value.after.text}`;
            const physical = {
                label: change.names.label,
                detail: change.names.detail,
                text: change.role === "count" ? `${text} entries` : text,
                filled: true,
                internal: change.role === "internal",
                before: change.value.before.data,
                after: change.value.after.data,
            };
            if (!change.entry) {
                return physical;
            }
            return recordRow(physical, change.entry, change.value.before.text, change.value.after.text, facts(change.entry));
        }
    }
}

// Rows -> one warning per BitArray written past its capacity, named by the row label without its bit index, e.g. `flags[20]` -> `flags`.
export function pastCapacityWarnings(lines: readonly StateDiffLine[]): string[] {
    const bitArrays = new Map<string, { capacity: number; indexes: number[] }>();

    for (const line of lines) {
        const bit = line.pastCapacity === undefined ? null : line.label.match(/^(.*)\[(\d+)\]$/);
        if (!bit) {
            continue;
        }
        const bitArray = bitArrays.get(bit[1]) ?? { capacity: line.pastCapacity!, indexes: [] };
        bitArray.indexes.push(Number(bit[2]));
        bitArrays.set(bit[1], bitArray);
    }

    return [...bitArrays].map(([path, bitArray]) => pastCapacityWarning(path, bitArray.capacity, bitArray.indexes));
}

// Decoded changes -> one row each, in state order.
function renderRows(decoded: DecodedChange[]): StateDiffLine[] {
    const entries = entriesOf(decoded);
    return decoded.map((change) => rowOf(change, entries));
}
