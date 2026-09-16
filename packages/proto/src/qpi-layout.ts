// Single source of truth for QPI container on-wire layouts (mirrors core src/qpi/qpi_containers.h).
import { roundUp } from "@qinit/core";

export const bitWordCount = (bitCount: number) => Math.ceil(bitCount / 64);

interface Layout {
    size: number;
    align: number;
}

const hashMapFlagWordCount = (capacity: number) => Math.ceil(capacity / 32);
const hashSetFlagWordCount = (capacity: number) => Math.ceil(capacity / 32);
const collectionFlagWordCount = (capacity: number) => Math.ceil(capacity / 32);
const linkedListFlagWordCount = (capacity: number) => Math.ceil(capacity / 64);

function layoutSize(value: number): number {
    if (!Number.isSafeInteger(value)) {
        throw new Error("QPI layout size exceeds the safe integer range");
    }
    return value;
}

// core static_asserts L = 2^N for every container, which is what lets `index & (L - 1)` stand in for a bounds check.
export function arrayGeometry(element: Layout, count: number) {
    const stride = roundUp(element.size, element.align);
    return {
        stride,
        size: layoutSize(stride * count),
        align: element.align,
    };
}

export function bitArrayGeometry(bitCount: number) {
    return {
        size: layoutSize(bitWordCount(bitCount) * 8),
        align: 8,
    };
}

// core: struct Element { KeyT key; ValueT value; } _elements[L]; uint64 _occupationFlags[(L * 2 + 63) / 64]; uint64 _population; uint64 _markRemovalCounter;
export function hashMapGeometry(key: Layout, value: Layout, capacity: number) {
    const elementValueOffset = roundUp(key.size, value.align);
    const align = Math.max(key.align, value.align, 8);
    const elementStride = roundUp(elementValueOffset + value.size, Math.max(key.align, value.align));
    const flagsOffset = roundUp(layoutSize(capacity * elementStride), 8);
    const flagsBytes = hashMapFlagWordCount(capacity) * 8;
    const populationOffset = layoutSize(flagsOffset + flagsBytes);
    const markRemovalCounterOffset = populationOffset + 8;
    return {
        elementStride,
        elementValueOffset,
        flagsOffset,
        flagsBytes,
        populationOffset,
        markRemovalCounterOffset,
        size: layoutSize(roundUp(markRemovalCounterOffset + 8, align)),
        align,
    };
}

// core: KeyT _keys[L]; uint64 _occupationFlags[(L * 2 + 63) / 64]; uint64 _population; uint64 _markRemovalCounter;
export function hashSetGeometry(key: Layout, capacity: number) {
    const align = Math.max(key.align, 8);
    const keyStride = roundUp(key.size, key.align);
    const flagsOffset = roundUp(layoutSize(capacity * keyStride), 8);
    const flagsBytes = hashSetFlagWordCount(capacity) * 8;
    const populationOffset = layoutSize(flagsOffset + flagsBytes);
    const markRemovalCounterOffset = populationOffset + 8;
    return {
        keyStride,
        flagsOffset,
        flagsBytes,
        populationOffset,
        markRemovalCounterOffset,
        size: layoutSize(roundUp(markRemovalCounterOffset + 8, align)),
        align,
    };
}

// core: struct PoV { id value; uint64 population; sint64 headIndex, tailIndex; sint64 bstRootIndex; } _povs[L]; uint64 _povOccupationFlags[(L * 2 + 63) / 64];
//       struct Element { T value; sint64 priority; sint64 povIndex; sint64 bstParentIndex; sint64 bstLeftIndex; sint64 bstRightIndex; } _elements[L];
//       uint64 _population; uint64 _markRemovalCounter;
export function collectionGeometry(value: Layout, capacity: number) {
    const povValueOffset = 0;
    const povPopulationOffset = 32;
    const povHeadIndexOffset = 40;
    const povTailIndexOffset = 48;
    const povBstRootIndexOffset = 56;
    const povStride = 64;
    const flagsOffset = layoutSize(capacity * povStride);
    const flagsBytes = collectionFlagWordCount(capacity) * 8;
    const align = Math.max(value.align, 8);
    const elementsOffset = roundUp(flagsOffset + flagsBytes, align);
    const elementValueOffset = 0;
    const elementPriorityOffset = roundUp(value.size, 8);
    const elementPovIndexOffset = elementPriorityOffset + 8;
    const elementBstParentIndexOffset = elementPovIndexOffset + 8;
    const elementBstLeftIndexOffset = elementBstParentIndexOffset + 8;
    const elementBstRightIndexOffset = elementBstLeftIndexOffset + 8;
    const elementStride = roundUp(elementBstRightIndexOffset + 8, align);
    const populationOffset = layoutSize(elementsOffset + capacity * elementStride);
    const markRemovalCounterOffset = populationOffset + 8;
    return {
        povsOffset: 0,
        povStride,
        povValueOffset,
        povPopulationOffset,
        povHeadIndexOffset,
        povTailIndexOffset,
        povBstRootIndexOffset,
        flagsOffset,
        flagsBytes,
        elementsOffset,
        elementStride,
        elementValueOffset,
        elementPriorityOffset,
        elementPovIndexOffset,
        elementBstParentIndexOffset,
        elementBstLeftIndexOffset,
        elementBstRightIndexOffset,
        populationOffset,
        markRemovalCounterOffset,
        size: layoutSize(roundUp(markRemovalCounterOffset + 8, align)),
        align,
    };
}

// core: struct Node { T value; sint64 nextIndex; sint64 prevIndex; } _nodes[L]; uint64 _occupiedFlags[(L + 63) / 64];
//       sint64 _headIndex; sint64 _tailIndex; sint64 _freeHeadIndex; uint64 _nextUnusedIndex; uint64 _population;
export function linkedListGeometry(value: Layout, capacity: number) {
    const align = Math.max(value.align, 8);
    const nextIndexOffset = roundUp(value.size, 8);
    const prevIndexOffset = nextIndexOffset + 8;
    const nodeStride = roundUp(prevIndexOffset + 8, align);
    const flagsOffset = layoutSize(capacity * nodeStride);
    const flagsBytes = linkedListFlagWordCount(capacity) * 8;
    const headIndexOffset = flagsOffset + flagsBytes;
    const tailIndexOffset = headIndexOffset + 8;
    const freeHeadIndexOffset = tailIndexOffset + 8;
    const nextUnusedIndexOffset = freeHeadIndexOffset + 8;
    const populationOffset = nextUnusedIndexOffset + 8;
    return {
        nextIndexOffset,
        prevIndexOffset,
        nodeStride,
        flagsOffset,
        flagsBytes,
        headIndexOffset,
        tailIndexOffset,
        freeHeadIndexOffset,
        nextUnusedIndexOffset,
        populationOffset,
        size: layoutSize(roundUp(populationOffset + 8, align)),
        align,
    };
}

// Container regions: geometry above says where a container's bytes are, these tables what each run is called in qpi_containers.h — pinned by a drift test.

export type MemberRole = "payload" | "count" | "internal";
// Container bookkeeping is not in the IDL, so a member names either one of the container's own IDL types or the fixed word it is stored as.
export type WordType = "sint64" | "uint64" | "id";
export type MemberType = WordType | "key" | "value";

export interface ContainerMember {
    off: number;
    size: number;
    path: string;
    short: string;
    source: string;
    type: MemberType;
    role: MemberRole;
}

// A strided run of L slots — core's _elements, _keys, _povs or _nodes — each holding the same members.
export type SlotsRegion = {
    kind: "slots";
    off: number;
    end: number;
    stride: number;
    path: string;
    short: string;
    source: string;
    members: ContainerMember[];
};

// A packed run of `bitsPerSlot` bits per slot, over the same L as the slots it flags; core sizes the two together.
export type FlagsRegion = {
    kind: "flags";
    off: number;
    end: number;
    path: string;
    source: string;
    bitsPerSlot: number;
    capacity: number;
};

// One 8-byte bookkeeping word, or the 32-byte id a word-typed member is stored as.
export type WordRegion = {
    kind: "word";
    off: number;
    end: number;
    path: string;
    short: string;
    source: string;
    type: WordType;
    role: MemberRole;
};

export type ContainerRegion = SlotsRegion | FlagsRegion | WordRegion;

// `source` is core's own spelling, pinned against the bundled header by the drift test; the display `path` may diverge from it, `source` may not.
// A displayed name is core's own with a dot in front, so the member a path pins is the path without that dot; only slot arrays pass their own name.
const sourceOf = (path: string) => path.replace(/^\./, "");

const member = (off: number, size: number, path: string, type: MemberType, role: MemberRole, short = path): ContainerMember => ({
    off,
    size,
    path,
    short,
    source: sourceOf(path),
    type,
    role,
});

const slots = (off: number, stride: number, capacity: number, path: string, short: string, source: string, members: ContainerMember[]): SlotsRegion => ({
    kind: "slots",
    off,
    end: off + stride * capacity,
    stride,
    path,
    short,
    source,
    members,
});

const flags = (off: number, size: number, bitsPerSlot: number, capacity: number, path: string): FlagsRegion => ({
    kind: "flags",
    off,
    end: off + size,
    path,
    source: sourceOf(path),
    bitsPerSlot,
    capacity,
});

const word = (off: number, path: string, type: WordType, role: MemberRole, short = path): WordRegion => ({
    kind: "word",
    off,
    end: off + 8,
    path,
    short,
    source: sourceOf(path),
    type,
    role,
});

// core: struct Element { KeyT key; ValueT value; } _elements[L];
//       uint64 _occupationFlags[(L * 2 + 63) / 64];   // 0b00 not occupied, 0b01 occupied, 0b10 occupied but marked for removal
//       uint64 _population; uint64 _markRemovalCounter;
export type HashMapRegions = {
    elements: SlotsRegion;
    occupationFlags: FlagsRegion;
    population: WordRegion;
    markRemovalCounter: WordRegion;
};

export function hashMapRegions(key: Layout, value: Layout, capacity: number): HashMapRegions {
    const geometry = hashMapGeometry(key, value, capacity);
    return {
        elements: slots(0, geometry.elementStride, capacity, "._elements", ".slot", "_elements", [
            member(0, key.size, ".key", "key", "payload"),
            member(geometry.elementValueOffset, value.size, ".value", "value", "payload"),
        ]),
        occupationFlags: flags(geometry.flagsOffset, geometry.flagsBytes, 2, capacity, "._occupationFlags"),
        population: word(geometry.populationOffset, "._population", "uint64", "count", ""),
        markRemovalCounter: word(geometry.markRemovalCounterOffset, "._markRemovalCounter", "uint64", "internal"),
    };
}

// core: KeyT _keys[L];
//       uint64 _occupationFlags[(L * 2 + 63) / 64];   // same encoding as HashMap
//       uint64 _population; uint64 _markRemovalCounter;
export type HashSetRegions = {
    keys: SlotsRegion;
    occupationFlags: FlagsRegion;
    population: WordRegion;
    markRemovalCounter: WordRegion;
};

export function hashSetRegions(key: Layout, capacity: number): HashSetRegions {
    const geometry = hashSetGeometry(key, capacity);
    return {
        // a slot is the key itself, so the member has an empty path with nothing below it to name
        keys: slots(0, geometry.keyStride, capacity, "._keys", ".slot", "_keys", [member(0, key.size, "", "key", "payload")]),
        occupationFlags: flags(geometry.flagsOffset, geometry.flagsBytes, 2, capacity, "._occupationFlags"),
        population: word(geometry.populationOffset, "._population", "uint64", "count", ""),
        markRemovalCounter: word(geometry.markRemovalCounterOffset, "._markRemovalCounter", "uint64", "internal"),
    };
}

// core: struct PoV { id value; uint64 population; sint64 headIndex, tailIndex; sint64 bstRootIndex; } _povs[L];
//       uint64 _povOccupationFlags[(L * 2 + 63) / 64];   // same encoding as HashMap, over _povs
//       struct Element { T value; sint64 priority; sint64 povIndex; sint64 bstParentIndex; sint64 bstLeftIndex; sint64 bstRightIndex; } _elements[L];
//       uint64 _population; uint64 _markRemovalCounter;
// two slot arrays with opposite rules: _povs is a hash map with its own flags, _elements is filled sequentially, has no flags, and remove moves the last element into the gap.
export type CollectionRegions = {
    povs: SlotsRegion;
    povOccupationFlags: FlagsRegion;
    elements: SlotsRegion;
    population: WordRegion;
    markRemovalCounter: WordRegion;
};

export function collectionRegions(value: Layout, capacity: number): CollectionRegions {
    const geometry = collectionGeometry(value, capacity);
    return {
        // the pov id is what the contract grouped by; it is typed "id", not "key", so it names no entry today
        povs: slots(0, geometry.povStride, capacity, "._povs", ".pov", "_povs", [
            member(geometry.povValueOffset, 32, ".value", "id", "payload", ""),
            member(geometry.povPopulationOffset, 8, ".population", "uint64", "internal"),
            member(geometry.povHeadIndexOffset, 8, ".headIndex", "sint64", "internal"),
            member(geometry.povTailIndexOffset, 8, ".tailIndex", "sint64", "internal"),
            member(geometry.povBstRootIndexOffset, 8, ".bstRootIndex", "sint64", "internal"),
        ]),
        povOccupationFlags: flags(geometry.flagsOffset, geometry.flagsBytes, 2, capacity, "._povOccupationFlags"),
        // priority is passed in by the contract; the bst links and the pov index are core's own
        elements: slots(geometry.elementsOffset, geometry.elementStride, capacity, "._elements", "", "_elements", [
            member(geometry.elementValueOffset, value.size, ".value", "value", "payload", ""),
            member(geometry.elementPriorityOffset, 8, ".priority", "sint64", "payload"),
            member(geometry.elementPovIndexOffset, 8, ".povIndex", "sint64", "internal"),
            member(geometry.elementBstParentIndexOffset, 8, ".bstParentIndex", "sint64", "internal"),
            member(geometry.elementBstLeftIndexOffset, 8, ".bstLeftIndex", "sint64", "internal"),
            member(geometry.elementBstRightIndexOffset, 8, ".bstRightIndex", "sint64", "internal"),
        ]),
        population: word(geometry.populationOffset, "._population", "uint64", "count", ""),
        markRemovalCounter: word(geometry.markRemovalCounterOffset, "._markRemovalCounter", "uint64", "internal"),
    };
}

// core: struct Node { T value; sint64 nextIndex; sint64 prevIndex; } _nodes[L];
//       uint64 _occupiedFlags[(L + 63) / 64];   // 1 bit per node: 1 occupied, 0 free
//       sint64 _headIndex; sint64 _tailIndex; sint64 _freeHeadIndex; uint64 _nextUnusedIndex; uint64 _population;
// freed nodes are recycled through _freeHeadIndex, never-used ones handed out through _nextUnusedIndex; no cleanup step exists.
export type LinkedListRegions = {
    nodes: SlotsRegion;
    occupiedFlags: FlagsRegion;
    headIndex: WordRegion;
    tailIndex: WordRegion;
    freeHeadIndex: WordRegion;
    nextUnusedIndex: WordRegion;
    population: WordRegion;
};

export function linkedListRegions(value: Layout, capacity: number): LinkedListRegions {
    const geometry = linkedListGeometry(value, capacity);
    return {
        nodes: slots(0, geometry.nodeStride, capacity, "._nodes", "", "_nodes", [
            member(0, value.size, ".value", "value", "payload", ""),
            member(geometry.nextIndexOffset, 8, ".nextIndex", "sint64", "internal"),
            member(geometry.prevIndexOffset, 8, ".prevIndex", "sint64", "internal"),
        ]),
        occupiedFlags: flags(geometry.flagsOffset, geometry.flagsBytes, 1, capacity, "._occupiedFlags"),
        headIndex: word(geometry.headIndexOffset, "._headIndex", "sint64", "internal"),
        tailIndex: word(geometry.tailIndexOffset, "._tailIndex", "sint64", "internal"),
        freeHeadIndex: word(geometry.freeHeadIndexOffset, "._freeHeadIndex", "sint64", "internal"),
        nextUnusedIndex: word(geometry.nextUnusedIndexOffset, "._nextUnusedIndex", "uint64", "internal"),
        population: word(geometry.populationOffset, "._population", "uint64", "count", ""),
    };
}

// Sub-record field-token shapes (type-format fragments; alignment handled by parseTypeFormat), e.g. PoV{ id value; uint64 population; sint64 head, tail, bstRoot }.
export const COLLECTION_POV_FMT = "id, uint64, sint64, sint64, sint64";
//   Collection Element trailer after the T value: sint64 priority, povIndex, bstParent, bstLeft, bstRight
export const COLLECTION_ELEM_TRAILER_FMT = "sint64, sint64, sint64, sint64, sint64";

// Element-record formats compose the complete physical container formats.
export const hashMapElemFmt = (keyFmt: string, valFmt: string) => `${keyFmt}, ${valFmt}`;
export const collectionElemFmt = (valFmt: string) => `${valFmt}, ${COLLECTION_ELEM_TRAILER_FMT}`;
export const linkedListElemFmt = (valFmt: string) => `${valFmt}, sint64, sint64`;

// Full struct formats consumed by IDL formatting and ABI layout parsing.
export const hashMapFmt = (keyFmt: string, valFmt: string, capacity: number) =>
    `{ [${capacity};{ ${hashMapElemFmt(keyFmt, valFmt)} }], [${hashMapFlagWordCount(capacity)};uint64], uint64, uint64 }`;
export const hashSetFmt = (keyFmt: string, capacity: number) => `{ [${capacity};${keyFmt}], [${hashSetFlagWordCount(capacity)};uint64], uint64, uint64 }`;
export const collectionFmt = (valFmt: string, capacity: number) =>
    `{ [${capacity};{ ${COLLECTION_POV_FMT} }], [${collectionFlagWordCount(capacity)};uint64], [${capacity};{ ${collectionElemFmt(valFmt)} }], uint64, uint64 }`;
export const linkedListFmt = (valFmt: string, capacity: number) =>
    `{ [${capacity};{ ${linkedListElemFmt(valFmt)} }], [${linkedListFlagWordCount(capacity)};uint64], sint64, sint64, sint64, uint64, uint64 }`;
