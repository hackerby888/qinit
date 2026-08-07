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

export function hashMapGeometry(
  key: Layout,
  value: Layout,
  capacity: number,
) {
  const valueOffset = roundUp(key.size, value.align);
  const align = Math.max(key.align, value.align, 8);
  const recordStride = roundUp(
    valueOffset + value.size,
    Math.max(key.align, value.align),
  );
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
export const hashSetFmt = (keyFmt: string, capacity: number) =>
  `{ [${capacity};${keyFmt}], [${hashSetFlagWordCount(capacity)};uint64], uint64, uint64 }`;
export const collectionFmt = (valFmt: string, capacity: number) =>
  `{ [${capacity};{ ${COLLECTION_POV_FMT} }], [${collectionFlagWordCount(capacity)};uint64], [${capacity};{ ${collectionElemFmt(valFmt)} }], uint64, uint64 }`;
export const linkedListFmt = (valFmt: string, capacity: number) =>
  `{ [${capacity};{ ${linkedListElemFmt(valFmt)} }], [${linkedListFlagWordCount(capacity)};uint64], sint64, sint64, sint64, uint64, uint64 }`;
