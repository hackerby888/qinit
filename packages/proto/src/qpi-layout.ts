// Single source of truth for QPI container on-wire layouts (mirrors core src/qpi/qpi_containers.h).
// Both the IDL fmt-string builder (build/idl.ts `typeToken`) and the logical decoders (decode-container.ts)
import { roundUp } from "@qinit/core";

export const SLOTS_PER_FLAG_WORD = 32;
export const FLAG_BITS_PER_SLOT = 2;
export const flagWordCount = (capacity: number) => Math.ceil((capacity * FLAG_BITS_PER_SLOT) / 64);
export const bitWordCount = (bitCount: number) => Math.ceil(bitCount / 64);

interface Layout {
  size: number;
  align: number;
}

const flagBytes = (capacity: number) => flagWordCount(capacity) * 8;

export function hashMapGeometry(
  key: Layout,
  value: Layout,
  capacity: number,
) {
  const valueOffset = roundUp(key.size, value.align);
  const recordStride = roundUp(
    valueOffset + value.size,
    Math.max(key.align, value.align),
  );
  const flagsOffset = roundUp(capacity * recordStride, 8);
  const flagsBytes = flagBytes(capacity);
  return {
    recordStride,
    valueOffset,
    flagsOffset,
    flagsBytes,
    populationOffset: flagsOffset + flagsBytes,
  };
}

export function hashSetGeometry(key: Layout, capacity: number) {
  const recordStride = roundUp(key.size, key.align);
  const flagsOffset = roundUp(capacity * recordStride, 8);
  const flagsBytes = flagBytes(capacity);
  return {
    recordStride,
    flagsOffset,
    flagsBytes,
    populationOffset: flagsOffset + flagsBytes,
  };
}

export function collectionGeometry(value: Layout, capacity: number) {
  const povStride = 64;
  const flagsOffset = capacity * povStride;
  const flagsBytes = flagBytes(capacity);
  const elementAlign = Math.max(value.align, 8);
  const elementsOffset = roundUp(flagsOffset + flagsBytes, elementAlign);
  const priorityOffset = roundUp(value.size, 8);
  const elementStride = roundUp(priorityOffset + 5 * 8, elementAlign);
  return {
    povsOffset: 0,
    povStride,
    flagsOffset,
    flagsBytes,
    elementsOffset,
    elementStride,
    priorityOffset,
    populationOffset: elementsOffset + capacity * elementStride,
  };
}

export function linkedListGeometry(value: Layout, capacity: number) {
  const nodeAlign = Math.max(value.align, 8);
  const nextOffset = roundUp(value.size, 8);
  const prevOffset = nextOffset + 8;
  const nodeStride = roundUp(prevOffset + 8, nodeAlign);
  const flagsOffset = capacity * nodeStride;
  const flagsBytes = bitWordCount(capacity) * 8;
  const headOffset = flagsOffset + flagsBytes;
  const tailOffset = headOffset + 8;
  const freeHeadOffset = tailOffset + 8;
  const nextUnusedOffset = freeHeadOffset + 8;
  const populationOffset = nextUnusedOffset + 8;
  return {
    nodeAlign,
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
    size: roundUp(populationOffset + 8, nodeAlign),
    align: nodeAlign,
  };
}

export function bitAt(bytes: Uint8Array, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0) return 0;
  const byteOffset = Math.floor(index / 8);
  return byteOffset < bytes.length
    ? (bytes[byteOffset] >> (index & 7)) & 1
    : 0;
}

export function occupationFlagAt(flags: Uint8Array, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0) return 0;
  const offset = Math.floor(index / SLOTS_PER_FLAG_WORD) * 8;
  if (offset + 8 > flags.length) return 0;
  const word = new DataView(flags.buffer, flags.byteOffset + offset, 8).getBigUint64(0, true);
  return Number((word >> BigInt((index % SLOTS_PER_FLAG_WORD) * FLAG_BITS_PER_SLOT)) & 3n);
}

// Sub-record field-token shapes (abi-fmt fmt fragments; alignment handled by abi-fmt's parseLayout).
//   Collection PoV{ id value; uint64 population; sint64 head, tail, bstRoot }
export const COLLECTION_POV_FMT = "id, uint64, sint64, sint64, sint64";
//   Collection Element trailer after the T value: sint64 priority, povIndex, bstParent, bstLeft, bstRight
export const COLLECTION_ELEM_TRAILER_FMT = "sint64, sint64, sint64, sint64, sint64";

// Element-record fmts (used by the decoders for stride + field offsets).
export const hashMapElemFmt = (keyFmt: string, valFmt: string) => `${keyFmt}, ${valFmt}`;
export const collectionElemFmt = (valFmt: string) => `${valFmt}, ${COLLECTION_ELEM_TRAILER_FMT}`;
export const linkedListElemFmt = (valFmt: string) => `${valFmt}, sint64, sint64`;

// Full struct fmts consumed by typeToken, layoutOf, and the logical decoders.
export const hashMapFmt = (keyFmt: string, valFmt: string, capacity: number) =>
  `{ [${capacity};{ ${hashMapElemFmt(keyFmt, valFmt)} }], [${flagWordCount(capacity)};uint64], uint64, uint64 }`;
export const hashSetFmt = (keyFmt: string, capacity: number) =>
  `{ [${capacity};${keyFmt}], [${flagWordCount(capacity)};uint64], uint64, uint64 }`;
export const collectionFmt = (valFmt: string, capacity: number) =>
  `{ [${capacity};{ ${COLLECTION_POV_FMT} }], [${flagWordCount(capacity)};uint64], [${capacity};{ ${collectionElemFmt(valFmt)} }], uint64, uint64 }`;
export const linkedListFmt = (valFmt: string, capacity: number) =>
  `{ [${capacity};{ ${linkedListElemFmt(valFmt)} }], [${bitWordCount(capacity)};uint64], sint64, sint64, sint64, uint64, uint64 }`;
