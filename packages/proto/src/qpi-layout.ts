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

export function hashMapGeometry(key: Layout, value: Layout, capacity: number) {
    const valueOffset = roundUp(key.size, value.align);
    const align = Math.max(key.align, value.align, 8);
    const recordStride = roundUp(valueOffset + value.size, Math.max(key.align, value.align));
    const flagsOffset = roundUp(layoutSize(capacity * recordStride), 8);
    const flagsBytes = hashMapFlagWordCount(capacity) * 8;
    const populationOffset = layoutSize(flagsOffset + flagsBytes);
    return {
        recordStride,
        valueOffset,
        flagsOffset,
        flagsBytes,
        populationOffset,
        size: layoutSize(roundUp(populationOffset + 16, align)),
        align,
    };
}

export function hashSetGeometry(key: Layout, capacity: number) {
    const align = Math.max(key.align, 8);
    const recordStride = roundUp(key.size, key.align);
    const flagsOffset = roundUp(layoutSize(capacity * recordStride), 8);
    const flagsBytes = hashSetFlagWordCount(capacity) * 8;
    const populationOffset = layoutSize(flagsOffset + flagsBytes);
    return {
        recordStride,
        flagsOffset,
        flagsBytes,
        populationOffset,
        size: layoutSize(roundUp(populationOffset + 16, align)),
        align,
    };
}

export function collectionGeometry(value: Layout, capacity: number) {
    const povValueOffset = 0;
    const povPopulationOffset = 32;
    const povHeadOffset = 40;
    const povTailOffset = 48;
    const povBstRootOffset = 56;
    const povStride = 64;
    const flagsOffset = layoutSize(capacity * povStride);
    const flagsBytes = collectionFlagWordCount(capacity) * 8;
    const align = Math.max(value.align, 8);
    const elementsOffset = roundUp(flagsOffset + flagsBytes, align);
    const elementValueOffset = 0;
    const elementPriorityOffset = roundUp(value.size, 8);
    const elementPovIndexOffset = elementPriorityOffset + 8;
    const elementBstParentOffset = elementPovIndexOffset + 8;
    const elementBstLeftOffset = elementBstParentOffset + 8;
    const elementBstRightOffset = elementBstLeftOffset + 8;
    const elementStride = roundUp(elementBstRightOffset + 8, align);
    const populationOffset = layoutSize(elementsOffset + capacity * elementStride);
    return {
        povsOffset: 0,
        povStride,
        povValueOffset,
        povPopulationOffset,
        povHeadOffset,
        povTailOffset,
        povBstRootOffset,
        flagsOffset,
        flagsBytes,
        elementsOffset,
        elementStride,
        elementValueOffset,
        elementPriorityOffset,
        elementPovIndexOffset,
        elementBstParentOffset,
        elementBstLeftOffset,
        elementBstRightOffset,
        populationOffset,
        size: layoutSize(roundUp(populationOffset + 16, align)),
        align,
    };
}

export function linkedListGeometry(value: Layout, capacity: number) {
    const align = Math.max(value.align, 8);
    const nextOffset = roundUp(value.size, 8);
    const prevOffset = nextOffset + 8;
    const nodeStride = roundUp(prevOffset + 8, align);
    const flagsOffset = layoutSize(capacity * nodeStride);
    const flagsBytes = linkedListFlagWordCount(capacity) * 8;
    const headOffset = flagsOffset + flagsBytes;
    const tailOffset = headOffset + 8;
    const freeHeadOffset = tailOffset + 8;
    const nextUnusedOffset = freeHeadOffset + 8;
    const populationOffset = nextUnusedOffset + 8;
    return {
        nextOffset,
        prevOffset,
        nodeStride,
        flagsOffset,
        flagsBytes,
        headOffset,
        tailOffset,
        freeHeadOffset,
        nextUnusedOffset,
        populationOffset,
        size: layoutSize(roundUp(populationOffset + 8, align)),
        align,
    };
}

// ---------- container members ----------
// The geometry above says where a container's bytes are; the tables below say what each run of them is
// called, under the name core gives it in qpi_containers.h. A drift test pins every `source` to that
// header, so a rename upstream fails a test instead of quietly showing the wrong label.

export type MemberRole = "payload" | "count" | "internal";
// Container bookkeeping is not in the IDL, so a member either names one of the container's own IDL types
// or the fixed word it is stored as.
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

export type ContainerRegion =
    | {
          kind: "records";
          off: number;
          end: number;
          stride: number;
          path: string;
          short: string;
          source: string;
          members: ContainerMember[];
      }
    | {
          kind: "flags";
          off: number;
          end: number;
          path: string;
          source: string;
          bitsPer: number;
          count: number;
      }
    | {
          kind: "word";
          off: number;
          end: number;
          path: string;
          short: string;
          source: string;
          type: WordType;
          role: MemberRole;
      };

// A displayed name is core's own with a dot in front of it, so the member a path pins is the path
// without that dot. Only the record arrays are shown under a different name and pass their own.
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

const records = (off: number, stride: number, count: number, path: string, short: string, source: string, members: ContainerMember[]): ContainerRegion => ({
    kind: "records",
    off,
    end: off + stride * count,
    stride,
    path,
    short,
    source,
    members,
});

const flags = (off: number, size: number, bitsPer: number, count: number, path: string): ContainerRegion => ({
    kind: "flags",
    off,
    end: off + size,
    path,
    source: sourceOf(path),
    bitsPer,
    count,
});

const word = (off: number, path: string, type: WordType, role: MemberRole, short = path): ContainerRegion => ({
    kind: "word",
    off,
    end: off + 8,
    path,
    short,
    source: sourceOf(path),
    type,
    role,
});

export function hashMapMembers(key: Layout, value: Layout, capacity: number): ContainerRegion[] {
    const geometry = hashMapGeometry(key, value, capacity);
    return [
        records(0, geometry.recordStride, capacity, ".slot", ".slot", "_elements", [
            member(0, key.size, ".key", "key", "payload"),
            member(geometry.valueOffset, value.size, ".value", "value", "payload"),
        ]),
        flags(geometry.flagsOffset, geometry.flagsBytes, 2, capacity, "._occupationFlags"),
        word(geometry.populationOffset, "._population", "uint64", "count", ""),
        word(geometry.populationOffset + 8, "._markRemovalCounter", "uint64", "internal"),
    ];
}

export function hashSetMembers(key: Layout, capacity: number): ContainerRegion[] {
    const geometry = hashSetGeometry(key, capacity);
    return [
        // A slot is the key, with no member below it to name.
        records(0, geometry.recordStride, capacity, ".slot", ".slot", "_keys", [member(0, key.size, "", "key", "payload")]),
        flags(geometry.flagsOffset, geometry.flagsBytes, 2, capacity, "._occupationFlags"),
        word(geometry.populationOffset, "._population", "uint64", "count", ""),
        word(geometry.populationOffset + 8, "._markRemovalCounter", "uint64", "internal"),
    ];
}

export function collectionMembers(value: Layout, capacity: number): ContainerRegion[] {
    const geometry = collectionGeometry(value, capacity);
    return [
        // The PoV id is the key the contract grouped by; the rest of the record is the priority queue's own.
        records(0, geometry.povStride, capacity, "._povs", ".pov", "_povs", [
            member(geometry.povValueOffset, 32, ".value", "id", "payload", ""),
            member(geometry.povPopulationOffset, 8, ".population", "uint64", "internal"),
            member(geometry.povHeadOffset, 8, ".headIndex", "sint64", "internal"),
            member(geometry.povTailOffset, 8, ".tailIndex", "sint64", "internal"),
            member(geometry.povBstRootOffset, 8, ".bstRootIndex", "sint64", "internal"),
        ]),
        flags(geometry.flagsOffset, geometry.flagsBytes, 2, capacity, "._povOccupationFlags"),
        // Priority is passed in by the contract; the BST links and the PoV index are not.
        records(geometry.elementsOffset, geometry.elementStride, capacity, "._elements", "", "_elements", [
            member(geometry.elementValueOffset, value.size, ".value", "value", "payload", ""),
            member(geometry.elementPriorityOffset, 8, ".priority", "sint64", "payload"),
            member(geometry.elementPovIndexOffset, 8, ".povIndex", "sint64", "internal"),
            member(geometry.elementBstParentOffset, 8, ".bstParentIndex", "sint64", "internal"),
            member(geometry.elementBstLeftOffset, 8, ".bstLeftIndex", "sint64", "internal"),
            member(geometry.elementBstRightOffset, 8, ".bstRightIndex", "sint64", "internal"),
        ]),
        word(geometry.populationOffset, "._population", "uint64", "count", ""),
        word(geometry.populationOffset + 8, "._markRemovalCounter", "uint64", "internal"),
    ];
}

export function linkedListMembers(value: Layout, capacity: number): ContainerRegion[] {
    const geometry = linkedListGeometry(value, capacity);
    return [
        records(0, geometry.nodeStride, capacity, "._nodes", "", "_nodes", [
            member(0, value.size, ".value", "value", "payload", ""),
            member(geometry.nextOffset, 8, ".nextIndex", "sint64", "internal"),
            member(geometry.prevOffset, 8, ".prevIndex", "sint64", "internal"),
        ]),
        flags(geometry.flagsOffset, geometry.flagsBytes, 1, capacity, "._occupiedFlags"),
        word(geometry.headOffset, "._headIndex", "sint64", "internal"),
        word(geometry.tailOffset, "._tailIndex", "sint64", "internal"),
        word(geometry.freeHeadOffset, "._freeHeadIndex", "sint64", "internal"),
        word(geometry.nextUnusedOffset, "._nextUnusedIndex", "uint64", "internal"),
        word(geometry.populationOffset, "._population", "uint64", "count", ""),
    ];
}

// Sub-record field-token shapes (abi-fmt fmt fragments; alignment handled by abi-fmt's parseLayout).
//   Collection PoV{ id value; uint64 population; sint64 head, tail, bstRoot }
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
