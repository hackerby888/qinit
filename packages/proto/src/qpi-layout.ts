// Single source of truth for QPI container on-wire layouts (mirrors core src/contracts/qpi.h).
// Both the IDL fmt-string builder (build/idl.ts `typeToken`) and the logical decoders (decode-container.ts)
// derive from this — a qpi.h layout change is ONE edit here instead of three drifting copies.
//
// 2-bit occupation flags packed into uint64 words: 32 slots/word, 2 bits/slot (00 empty, 01 occupied, 10 removed).
export const SLOTS_PER_FLAG_WORD = 32;
export const FLAG_BITS_PER_SLOT = 2;
export const flagWordCount = (capacity: number) => Math.ceil((capacity * FLAG_BITS_PER_SLOT) / 64);

// Sub-record field-token shapes (abi-fmt fmt fragments; alignment handled by abi-fmt's parseLayout).
//   Collection PoV{ id value; uint64 population; sint64 head, tail, bstRoot }
export const COLLECTION_POV_FMT = "id, uint64, sint64, sint64, sint64";
//   Collection Element trailer after the T value: sint64 priority, povIndex, bstParent, bstLeft, bstRight
export const COLLECTION_ELEM_TRAILER_FMT = "sint64, sint64, sint64, sint64, sint64";

// Element-record fmts (used by the decoders for stride + field offsets).
export const hashMapElemFmt = (keyFmt: string, valFmt: string) => `${keyFmt}, ${valFmt}`;
export const collectionElemFmt = (valFmt: string) => `${valFmt}, ${COLLECTION_ELEM_TRAILER_FMT}`;

// Full struct fmts (what typeToken emits + layoutOf/decode consume): elements[L], flags[ceil(2L/64)], counters.
export const hashMapFmt = (keyFmt: string, valFmt: string, capacity: number) =>
  `{ [${capacity};{ ${hashMapElemFmt(keyFmt, valFmt)} }], [${flagWordCount(capacity)};uint64], uint64, uint64 }`;
export const hashSetFmt = (keyFmt: string, capacity: number) =>
  `{ [${capacity};${keyFmt}], [${flagWordCount(capacity)};uint64], uint64, uint64 }`;
export const collectionFmt = (valFmt: string, capacity: number) =>
  `{ [${capacity};{ ${COLLECTION_POV_FMT} }], [${flagWordCount(capacity)};uint64], [${capacity};{ ${collectionElemFmt(valFmt)} }], uint64, uint64 }`;
