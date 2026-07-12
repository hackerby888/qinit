import { test, expect } from "bun:test";
import { flagWordCount, hashMapFmt, hashSetFmt, collectionFmt, hashMapElemFmt, collectionElemFmt, COLLECTION_POV_FMT } from "../../src/qpi-layout";
import { layoutOf } from "../../src/abi-fmt";

test("flagWordCount: 2 bits/slot, 32 slots/uint64 word", () => {
  expect([1, 32, 33, 64, 1024].map(flagWordCount)).toEqual([1, 1, 2, 2, 32]);
});

test("hashMapFmt: matches the C++ StateData layout + sizeof pin (41232)", () => {
  expect(hashMapFmt("id", "uint64", 1024)).toBe("{ [1024;{ id, uint64 }], [32;uint64], uint64, uint64 }");
  expect(layoutOf(hashMapFmt("id", "uint64", 1024)).size).toBe(41232);   // DbgMap marker offset
});

test("hashSetFmt / collectionFmt shapes", () => {
  expect(hashSetFmt("id", 64)).toBe("{ [64;id], [2;uint64], uint64, uint64 }");
  expect(collectionFmt("uint64", 4)).toBe("{ [4;{ id, uint64, sint64, sint64, sint64 }], [1;uint64], [4;{ uint64, sint64, sint64, sint64, sint64, sint64 }], uint64, uint64 }");
});

test("element fmts (consumed by the decoders) are the single source", () => {
  expect(hashMapElemFmt("id", "uint64")).toBe("id, uint64");
  expect(COLLECTION_POV_FMT).toBe("id, uint64, sint64, sint64, sint64");
  expect(collectionElemFmt("uint64")).toBe("uint64, sint64, sint64, sint64, sint64, sint64");
});
