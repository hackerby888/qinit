// Diffs read as fields/elements/members, not offsets and hex — container internals come from the region tables in @qinit/proto/qpi-layout.
import { decodeAbi, decodeAbiValue, decodedAbiToJson } from "@qinit/proto";
import { AbiScalarKind, AbiTypeKind, type AbiCollection, type AbiHashMap, type AbiHashSet, type AbiLinkedList, type AbiType } from "@qinit/proto/contract-idl";
import {
    arrayGeometry,
    collectionRegions,
    hashMapRegions,
    hashSetRegions,
    linkedListRegions,
    type FlagsRegion,
    type MemberRole,
    type SlotsRegion,
    type WordRegion,
    type WordType,
} from "@qinit/proto/qpi-layout";
import type { DebugStateRegion } from "@qinit/core";
import { holdsContainer, keyLabel, pastCapacityWarning, scalarText, type StateField, type StateLine } from "./state-format";
import { hexToBytes } from "@qinit/core";

// A diff row keeps both label forms: `label` for the default view, `detail` the full path; `internal` marks container bookkeeping hidden until the full view.
// `keyUnresolved`: entry unnamed, label fell back to the slot index. `pastCapacity`: the BitArray's declared size, on a bit the row's index lies beyond.
export type StateDiffLine = StateLine & {
    detail: string;
    internal: boolean;
    before?: unknown;
    after?: unknown;
    change?: "new" | "removed";
    keyUnresolved?: boolean;
    pastCapacity?: number;
};

// Reads a slot's key from the node when no window carries it. Only a value update gets here.
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

// Extends both names one level deeper, e.g. `balances` + `._elements[3]`; the label suffix differs only inside container internals.
const descend = (names: Names, detailSuffix: string, labelSuffix = detailSuffix): Names => ({
    detail: names.detail + detailSuffix,
    label: names.label + labelSuffix,
});

// One changed window with its images decoded from hex, read to the shorter image when the two differ in length.
type ChangedWindow = { start: number; end: number; before: Uint8Array; after: Uint8Array };
type ImagePair = { before: Uint8Array; after: Uint8Array };
type Rendered = { text: string; data: unknown };

// slot: the physical position core's isEmptySlot() speaks of. entry: the key -> value pair a row is named by. only hashmap and hashset have both.
// The slot a change belongs to: which part of which slot (with the path below the member), and where the key that names it sits.
type SlotRef = { part: "key" | "value" | "flag"; container: Names; slotIndex: number; suffix: string; keyStart: number; keyType: AbiType };

// The entry's key once looked up: both images when a window holds it, or the live key read back from the node for an update.
type EntryKey = { before: string; after: string } | { fetched: string };

// What stage one finds in a window, and what stage two hands on: the same change with bytes turned into text and its slot's key looked up.
type ChangeOf<Value, Slot> =
    | { kind: "value"; names: Names; role: MemberRole; value: Value; slot?: Slot }
    | { kind: "partial"; names: Names; role: MemberRole; offsetInValue: number; bytes: ImagePair }
    | { kind: "bit"; names: Names; role: MemberRole; from: number; to: number; pastCapacity?: number; slot?: Slot }
    | { kind: "unknown"; stateOffset: number };
type Change = ChangeOf<ImagePair & { type: AbiType }, SlotRef>;
type DecodedChange = ChangeOf<{ before: Rendered; after: Rendered }, SlotRef & { key?: EntryKey }>;

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

// A value straddling two windows can only be decoded once they are one range — core reports per dirty page, so a slot crossing a page arrives split.
// Only exactly-adjacent runs merge; the `/ 2` is because the images are hex.
function changedWindowsOf(changedWindows: DebugStateRegion[]): ChangedWindow[] {
    const joined: DebugStateRegion[] = [];

    for (const changedWindow of [...changedWindows].sort((left, right) => left.off - right.off)) {
        const last = joined[joined.length - 1];
        // adjacency is measured on `before`: both producers send equal-length images, and a lopsided one would shift the `after` of what merges behind it
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

// The keyed slot a walk is inside: which of its members and where its key sits, so every payload change beneath can be named by the entry.
type KeyedSlot = { part: "key" | "value"; container: Names; slotIndex: number; member: string; keyStart: number; keyType: AbiType };

// A packed run: `slotCount` slots of `bitsPerSlot` bits from an absolute state offset.
// `declaredCapacity` set only when the run stores more slots than the container declares, as a small BitArray's last word does.
type BitRun = { start: number; size: number; bitsPerSlot: number; slotCount: number; declaredCapacity?: number };

// The first and last index of a strided run that share a byte with the window — a 545 MB map's slots or flags are never walked whole.
function visibleIndices(window: ChangedWindow, start: number, stride: number, count: number): [number, number] {
    const first = Math.max(0, Math.floor((window.start - start) / stride));
    const last = Math.min(count - 1, Math.floor((window.end - 1 - start) / stride));
    return [first, last];
}

// The slot a change under `scope` belongs to; the path below the member is what the leaf's label adds to the member's.
const slotRefOf = (scope: KeyedSlot, label: string): SlotRef => ({
    part: scope.part,
    container: scope.container,
    slotIndex: scope.slotIndex,
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

    // IDL fields keep declaration order, which C++ lays out at rising offsets, so one forward pass sees every field and gap
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
// Each container has its own walker: the four share no internal layout beyond what qpi-layout spells out, so nothing here guesses across them.
// (names, absolute start of `type`, `type`, the keyed slot it sits in) -> changes pushed onto the walk.
function walkType(walk: Walk, names: Names, start: number, type: AbiType, scope?: KeyedSlot): void {
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
            const slot = scope && slotRefOf(scope, names.label);
            const slotAt = slot && ((index: number) => ({ ...slot, suffix: `${slot.suffix}[${index}]` }));
            // the whole storage word, not just bitCount: core's set(i) only masks the word index, so a small BitArray's tail bits are writable.
            const run = { start, size: type.size, bitsPerSlot: 1, slotCount: type.size * 8, declaredCapacity: type.bitCount };
            compareBits(walk, names, run, "payload", slotAt);
            return;
        }

        case AbiTypeKind.HASH_MAP:
            walkHashMap(walk, names, start, type, scope);
            return;

        case AbiTypeKind.HASH_SET:
            walkHashSet(walk, names, start, type, scope);
            return;

        case AbiTypeKind.COLLECTION:
            walkCollection(walk, names, start, type, scope);
            return;

        case AbiTypeKind.LINKED_LIST:
            walkLinkedList(walk, names, start, type, scope);
            return;

        default:
            compareValue(walk, names, start, type, "payload", scope);
    }
}

// core: struct Element { KeyT key; ValueT value; } _elements[L]; uint64 _occupationFlags[(L * 2 + 63) / 64]; uint64 _population; uint64 _markRemovalCounter;
function walkHashMap(walk: Walk, names: Names, start: number, type: AbiHashMap, scope?: KeyedSlot): void {
    const regions = hashMapRegions(type.key, type.value, type.capacity);

    walkSlots(walk, names, start, regions.elements, { key: type.key, value: type.value }, scope);
    // flag i belongs to _elements[i]; a flag that opened or closed a slot is the only name an all-zero element can get, so it carries where that element's key sits
    walkFlags(walk, names, start, regions.occupationFlags, keyedFlagAt(names, start, regions.elements, type.key));
    walkWord(walk, names, start, regions.population);
    // reusing a tombstone flips its flag 2 -> 1 but never decrements this counter, so it only rises until cleanup()
    walkWord(walk, names, start, regions.markRemovalCounter);
}

// core: KeyT _keys[L]; uint64 _occupationFlags[(L * 2 + 63) / 64]; uint64 _population; uint64 _markRemovalCounter;
function walkHashSet(walk: Walk, names: Names, start: number, type: AbiHashSet, scope?: KeyedSlot): void {
    const regions = hashSetRegions(type.key, type.capacity);

    // a slot is the key itself; there is no value member below it
    walkSlots(walk, names, start, regions.keys, { key: type.key }, scope);
    walkFlags(walk, names, start, regions.occupationFlags, keyedFlagAt(names, start, regions.keys, type.key));
    walkWord(walk, names, start, regions.population);
    walkWord(walk, names, start, regions.markRemovalCounter);
}

// core: struct PoV { id value; uint64 population; sint64 headIndex, tailIndex; sint64 bstRootIndex; } _povs[L]; uint64 _povOccupationFlags[(L * 2 + 63) / 64];
//       struct Element { T value; sint64 priority; sint64 povIndex; sint64 bstParentIndex; sint64 bstLeftIndex; sint64 bstRightIndex; } _elements[L];
//       uint64 _population; uint64 _markRemovalCounter;
function walkCollection(walk: Walk, names: Names, start: number, type: AbiCollection, scope?: KeyedSlot): void {
    const regions = collectionRegions(type.value, type.capacity);

    // _povs is the hash map. its pov id is typed "id", not "key", so no pov flag or element is named by it today; naming it would change every label
    walkSlots(walk, names, start, regions.povs, {}, scope);
    walkFlags(walk, names, start, regions.povOccupationFlags);
    // _elements has no flags: occupancy is implied by _population, and remove moves the last element into the gap, so a remove writes rows on an element nobody touched
    walkSlots(walk, names, start, regions.elements, { value: type.value }, scope);
    walkWord(walk, names, start, regions.population);
    walkWord(walk, names, start, regions.markRemovalCounter);
}

// core: struct Node { T value; sint64 nextIndex; sint64 prevIndex; } _nodes[L]; uint64 _occupiedFlags[(L + 63) / 64];
//       sint64 _headIndex; sint64 _tailIndex; sint64 _freeHeadIndex; uint64 _nextUnusedIndex; uint64 _population;
function walkLinkedList(walk: Walk, names: Names, start: number, type: AbiLinkedList, scope?: KeyedSlot): void {
    const regions = linkedListRegions(type.value, type.capacity);

    walkSlots(walk, names, start, regions.nodes, { value: type.value }, scope);
    // 1 bit per node and a node has no key, so a flag row stays bookkeeping with nothing to name
    walkFlags(walk, names, start, regions.occupiedFlags);
    walkWord(walk, names, start, regions.headIndex);
    walkWord(walk, names, start, regions.tailIndex);
    // the first add to zeroed state runs _initIfNeeded, which writes the NULL_INDEX sentinels: a first insert shows _freeHeadIndex 0 -> -1, not corruption
    walkWord(walk, names, start, regions.freeHeadIndex);
    walkWord(walk, names, start, regions.nextUnusedIndex);
    walkWord(walk, names, start, regions.population);
}

// The IDL type behind a slot's `key` and `value` members; a container without one of them leaves it out.
type SlotTypes = { key?: AbiType; value?: AbiType };

// Where slot i's key sits, for a flag row to be named by. Only a slots region with a key member can offer one, and that member is at offset 0 in both hashmap and hashset.
function keyedFlagAt(container: Names, start: number, region: SlotsRegion, keyType: AbiType): (slotIndex: number) => SlotRef {
    const keyMember = region.members.find((member) => member.type === "key");
    if (!keyMember) {
        throw new Error(`${region.source} has no key member to name a flag by`);
    }

    return (slotIndex) => ({
        part: "flag",
        container,
        slotIndex,
        suffix: "",
        keyStart: start + region.off + slotIndex * region.stride + keyMember.off,
        keyType,
    });
}

// The slots the window touches, member by member; a key or value member is walked as its IDL type inside the slot's scope, a word member compared as is.
// A nested container's payload keeps the outer entry's key; its bookkeeping words and flags stay its own.
// mechanics only: which regions a container has and what may name its entries is each walker's call above
function walkSlots(walk: Walk, names: Names, start: number, region: SlotsRegion, types: SlotTypes, outer?: KeyedSlot): void {
    const { window } = walk;
    if (!overlaps(window, start + region.off, region.end - region.off)) {
        return;
    }

    // only hashmap and hashset declare a key member, so only their slots can name an entry; every other slot walks unnamed
    const keyMember = types.key && region.members.find((member) => member.type === "key");
    const naming = types.key && keyMember ? { keyType: types.key, keyOff: keyMember.off } : undefined;
    const [first, last] = visibleIndices(window, start + region.off, region.stride, region.capacity);

    for (let slotIndex = first; slotIndex <= last; slotIndex++) {
        const slotStart = start + region.off + slotIndex * region.stride;
        const slot = descend(names, `${region.path}[${slotIndex}]`, `${region.short}[${slotIndex}]`);

        for (const member of region.members) {
            if (!overlaps(window, slotStart + member.off, member.size)) {
                continue;
            }

            // qpi-layout spells the same pair `path`/`short`, so this is where its vocabulary meets this module's `detail`/`label`.
            const named = descend(slot, member.path, member.short);
            if (member.type !== "key" && member.type !== "value") {
                compareValue(walk, named, slotStart + member.off, WORD_TYPES[member.type], member.role);
                continue;
            }

            const memberType = types[member.type];
            if (!memberType) {
                throw new Error(`${region.source} declares a ${member.type} member but its container has no ${member.type} type`);
            }
            const own = naming && {
                part: member.type,
                container: names,
                slotIndex,
                member: named.label,
                keyStart: slotStart + naming.keyOff,
                keyType: naming.keyType,
            };
            walkType(walk, named, slotStart + member.off, memberType, outer ?? own);
        }
    }
}

// A flags region as one packed run; `slotAt` names the slot a flag belongs to, when the container has a key to name it by.
function walkFlags(walk: Walk, names: Names, start: number, region: FlagsRegion, slotAt?: (slotIndex: number) => SlotRef): void {
    if (!overlaps(walk.window, start + region.off, region.end - region.off)) {
        return;
    }

    const run = { start: start + region.off, size: region.end - region.off, bitsPerSlot: region.bitsPerSlot, slotCount: region.capacity };
    compareBits(walk, descend(names, region.path), run, "internal", slotAt);
}

// One bookkeeping word compared as the fixed type core stores it in.
function walkWord(walk: Walk, names: Names, start: number, region: WordRegion): void {
    if (!overlaps(walk.window, start + region.off, region.end - region.off)) {
        return;
    }

    compareValue(walk, descend(names, region.path, region.short), start + region.off, WORD_TYPES[region.type], region.role);
}

// (names, the value's absolute start, its type) -> a `value` change when the window holds all of it, a `partial` one when the window cuts it, nothing when the bytes match.
function compareValue(walk: Walk, names: Names, start: number, type: AbiType, role: MemberRole, scope?: KeyedSlot): void {
    const { window } = walk;
    const visibleStart = Math.max(start, window.start);
    const visibleEnd = Math.min(start + type.size, window.end);
    const bytes = { before: imageSlice(window, window.before, visibleStart, visibleEnd), after: imageSlice(window, window.after, visibleStart, visibleEnd) };

    // A window carries unchanged bytes around the ones that moved; only the latter are worth a row.
    if (bytesEqual(bytes.before, bytes.after)) {
        return;
    }

    if (covers(window, start, type.size)) {
        walk.changes.push({ kind: "value", names, role, value: { ...bytes, type }, slot: scope && slotRefOf(scope, names.label) });
    } else {
        // A partial run: report the bytes that did change rather than invent the ones that did not.
        walk.changes.push({ kind: "partial", names, role, offsetInValue: visibleStart - start, bytes });
    }
}

// Occupation flags and BitArrays are packed, so report the indices that moved, not the raw words.
// (names, the packed run, the slot each index belongs to) -> one `bit` change per visible index whose value moved.
function compareBits(walk: Walk, names: Names, run: BitRun, role: MemberRole, slotAt?: (index: number) => SlotRef): void {
    const { window } = walk;
    // The whole run may start windows behind this one; only its visible slice is read.
    const visibleStart = Math.max(run.start, window.start);
    const visibleEnd = Math.min(run.start + run.size, window.end);
    const before = imageSlice(window, window.before, visibleStart, visibleEnd);
    const after = imageSlice(window, window.after, visibleStart, visibleEnd);
    const firstVisibleIndex = ((visibleStart - run.start) * 8) / run.bitsPerSlot;
    // reads one slot inside one byte: holds for the 1- and 2-bit runs core packs into little-endian words; a 3-bit run would straddle bytes
    const valueAt = (bytes: Uint8Array, index: number) => {
        const bit = (index - firstVisibleIndex) * run.bitsPerSlot;
        const byte = bytes[bit >> 3];
        if (byte === undefined) {
            return undefined;
        }
        const mask = (1 << run.bitsPerSlot) - 1;
        return (byte >> (bit & 7)) & mask;
    };

    // The slice only covers a bounded run of indices; without this the loop walks the whole capacity — 33M no-op turns per window on a 536 MB map.
    const visibleBits = Math.min(before.length, after.length) * 8;
    const lastIndex = Math.min(run.slotCount, firstVisibleIndex + Math.floor(visibleBits / run.bitsPerSlot));

    for (let index = firstVisibleIndex; index < lastIndex; index++) {
        const from = valueAt(before, index);
        const to = valueAt(after, index);
        if (from === undefined || to === undefined || from === to) {
            continue;
        }
        const pastCapacity = run.declaredCapacity !== undefined && index >= run.declaredCapacity ? run.declaredCapacity : undefined;
        walk.changes.push({ kind: "bit", names: descend(names, `[${index}]`), role, from, to, pastCapacity, slot: slotAt?.(index) });
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

// (the changes, every window of the diff, the node's key reader) -> the same changes with values rendered and each slot's key looked up.
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
    // In no window at all means this dispatch never touched it, so the node still holds it — except for a flag, since a slot that left reads back as zeros.
    const keyOf = async (slot: SlotRef): Promise<EntryKey | undefined> => {
        const size = slot.keyType.size;
        const before = imageAt(windows, "before", slot.keyStart, size);
        const after = imageAt(windows, "after", slot.keyStart, size);
        if (before && after) {
            return { before: await keyText(before, slot.keyType), after: await keyText(after, slot.keyType) };
        }
        if (slot.part === "flag" || !readKey) {
            return undefined;
        }
        const live = await fetchKey(slot.keyStart, size);
        return live && { fetched: await keyText(live, slot.keyType) };
    };

    const decoded: DecodedChange[] = [];

    for (const change of changes) {
        if (change.kind === "value") {
            const value = {
                before: await renderValue(change.value.before, change.value.type),
                after: await renderValue(change.value.after, change.value.type),
            };
            decoded.push({ ...change, value, slot: change.slot && { ...change.slot, key: await keyOf(change.slot) } });
        } else if (change.kind === "bit") {
            decoded.push({ ...change, slot: change.slot && { ...change.slot, key: await keyOf(change.slot) } });
        } else {
            decoded.push(change);
        }
    }

    return decoded;
}

// Stage three: rows. A slot's changes all describe one entry, so they read as one line labelled by the key the contract wrote; the slot index stays on the full path.

// What the other rows of a slot say about it: the flag that opened or closed it, and which of its parts have a row that found its key.
// `to` is the raw flag: 1 = occupied (0b01), 2 = marked for removal (0b10), the encoding HashMap and HashSet share in qpi_containers.h.
// only a container with a key member reaches here, so a keyed container with other flags would need its own reading
type SlotFacts = { flag?: { to: number }; hasKeyRow: boolean; hasValueRow: boolean; namedByValue: boolean };
type DecodedSlotRef = SlotRef & { key?: EntryKey };

// The map key tying every change of one slot together: container path + slot index.
const slotIdOf = (slot: SlotRef) => `${slot.container.detail}#${slot.slotIndex}`;

// A flag's new value as the row's change kind: 1 -> new, 2 -> removed, anything else -> undefined.
const changeOf = (flag: { to: number } | undefined): "new" | "removed" | undefined => (flag?.to === 1 ? "new" : flag?.to === 2 ? "removed" : undefined);

// The key an entry's rows are named by. core zeroes the element on remove (CLEAR_UNUSED_ELEMENT), so only an arriving entry still has its key in the after image,
// and a key read back after a removal is those zeros — refused, so the row falls back to the slot index rather than naming a lie.
function namingKey(key: EntryKey, flag: SlotFacts["flag"]): string | undefined {
    // a slot only drops to 0 in cleanup() or reset(), which rewrite the element, so a 0 flag never meets a fetched key
    if ("fetched" in key) {
        return flag?.to === 2 ? undefined : key.fetched;
    }
    return flag && flag.to !== 1 ? key.before : key.after;
}

// An entry that just arrived has a zero before image, so `= v` says more than `0 → v`; one that left keeps its arrow, since the value it held is what matters.
function entryText(before: string, after: string, flag: SlotFacts["flag"]): string {
    if (flag?.to === 1) {
        return `= ${after} (new)`;
    }
    if (flag?.to === 2) {
        return `${before} → (removed)`;
    }
    return `${before} → ${after}`;
}

function slotFactsOf(decoded: DecodedChange[]): Map<string, SlotFacts> {
    const facts = new Map<string, SlotFacts>();
    const factsOf = (slot: SlotRef) => {
        const id = slotIdOf(slot);
        const known = facts.get(id) ?? { hasKeyRow: false, hasValueRow: false, namedByValue: false };
        facts.set(id, known);
        return known;
    };

    const slotRows = decoded.flatMap((change) => ((change.kind === "value" || change.kind === "bit") && change.slot ? [{ change, slot: change.slot }] : []));

    // Flags first: whether a value row can name its entry depends on the flag, so that question comes second.
    for (const { change, slot } of slotRows) {
        if (slot.part === "flag" && change.kind === "bit") {
            factsOf(slot).flag = { to: change.to };
        } else if (slot.key && slot.part === "value") {
            factsOf(slot).hasValueRow = true;
        } else if (slot.key && slot.part === "key") {
            factsOf(slot).hasKeyRow = true;
        }
    }
    for (const { slot } of slotRows) {
        if (slot.part === "value" && slot.key && namingKey(slot.key, factsOf(slot).flag) !== undefined) {
            factsOf(slot).namedByValue = true;
        }
    }

    return facts;
}

// A key or value row of a slot, named by the entry's key; `before`/`after` are the row's own images as text.
function slotRow(physical: StateDiffLine, slot: DecodedSlotRef, before: string, after: string, facts: SlotFacts): StateDiffLine {
    const key = slot.key && namingKey(slot.key, facts.flag);
    if (key === undefined) {
        // Keyed slot, key not found: the label is the slot index, not an identity, and the row says so.
        return slot.part === "value" ? { ...physical, keyUnresolved: true } : physical;
    }

    const label = `${slot.container.label}[${key}]${slot.suffix}`;
    if (slot.part === "value") {
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
function flagRow(physical: StateDiffLine, slot: DecodedSlotRef, to: number, facts: SlotFacts): StateDiffLine {
    const key = slot.key && !("fetched" in slot.key) ? (to === 1 ? slot.key.after : to === 2 ? slot.key.before : undefined) : undefined;
    if (key === undefined || facts.hasValueRow || facts.hasKeyRow) {
        return physical;
    }
    return { ...physical, label: `${slot.container.label}[${key}]`, text: to === 1 ? "(new)" : "(removed)", internal: false, change: changeOf({ to }) };
}

// One decoded change -> its final row; a change inside a container slot is named by its entry here and nowhere else.
function rowOf(change: DecodedChange, facts: Map<string, SlotFacts>): StateDiffLine {
    const factsOf = (slot: SlotRef) => facts.get(slotIdOf(slot)) ?? { hasKeyRow: false, hasValueRow: false, namedByValue: false };

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
            if (!change.slot) {
                return marked(physical);
            }
            return marked(
                change.slot.part === "flag"
                    ? flagRow(physical, change.slot, change.to, factsOf(change.slot))
                    : slotRow(physical, change.slot, String(change.from), String(change.to), factsOf(change.slot)),
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
            if (!change.slot) {
                return physical;
            }
            return slotRow(physical, change.slot, change.value.before.text, change.value.after.text, factsOf(change.slot));
        }
    }
}

function renderRows(decoded: DecodedChange[]): StateDiffLine[] {
    const facts = slotFactsOf(decoded);
    return decoded.map((change) => rowOf(change, facts));
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
