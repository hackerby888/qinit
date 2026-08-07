import { test, expect } from "bun:test";
import {
  arrayGeometry,
  bitArrayGeometry,
  bitWordCount,
  hashMapFmt,
  hashSetFmt,
  collectionFmt,
  linkedListFmt,
  hashMapElemFmt,
  collectionElemFmt,
  collectionGeometry,
  hashMapGeometry,
  hashSetGeometry,
  linkedListGeometry,
  COLLECTION_POV_FMT,
} from "../../src/qpi-layout";
import { layoutOf } from "../../src/abi-fmt";

test("BitArray word count covers every logical bit", () => {
  expect([1, 64, 65, 4096].map(bitWordCount)).toEqual([1, 1, 2, 64]);
});

test("array and BitArray geometry includes physical size and alignment", () => {
  expect(arrayGeometry({ size: 3, align: 2 }, 4)).toEqual({
    stride: 4,
    size: 16,
    align: 2,
  });
  expect(bitArrayGeometry(65)).toEqual({ size: 16, align: 8 });
});

test("container geometry aligns flags and Collection elements", () => {
  expect(
    hashMapGeometry({ size: 1, align: 1 }, { size: 1, align: 1 }, 1),
  ).toEqual({
    recordStride: 2,
    valueOffset: 1,
    flagsOffset: 8,
    flagsBytes: 8,
    populationOffset: 16,
    size: 32,
    align: 8,
  });
  expect(hashSetGeometry({ size: 1, align: 1 }, 4)).toEqual({
    recordStride: 1,
    flagsOffset: 8,
    flagsBytes: 8,
    populationOffset: 16,
    size: 32,
    align: 8,
  });
  expect(collectionGeometry({ size: 16, align: 16 }, 1)).toEqual({
    povsOffset: 0,
    povStride: 64,
    povValueOffset: 0,
    povPopulationOffset: 32,
    povHeadOffset: 40,
    povTailOffset: 48,
    povBstRootOffset: 56,
    flagsOffset: 64,
    flagsBytes: 8,
    elementsOffset: 80,
    elementStride: 64,
    elementValueOffset: 0,
    elementPriorityOffset: 16,
    elementPovIndexOffset: 24,
    elementBstParentOffset: 32,
    elementBstLeftOffset: 40,
    elementBstRightOffset: 48,
    populationOffset: 144,
    size: 160,
    align: 16,
  });
});

test("LinkedList geometry matches QPI node and header layout", () => {
  expect(linkedListGeometry({ size: 8, align: 8 }, 8)).toEqual({
    nextOffset: 8,
    prevOffset: 16,
    nodeStride: 24,
    flagsOffset: 192,
    flagsBytes: 8,
    headOffset: 200,
    tailOffset: 208,
    freeHeadOffset: 216,
    nextUnusedOffset: 224,
    populationOffset: 232,
    size: 240,
    align: 8,
  });
  expect(linkedListGeometry({ size: 24, align: 16 }, 2)).toEqual({
    nextOffset: 24,
    prevOffset: 32,
    nodeStride: 48,
    flagsOffset: 96,
    flagsBytes: 8,
    headOffset: 104,
    tailOffset: 112,
    freeHeadOffset: 120,
    nextUnusedOffset: 128,
    populationOffset: 136,
    size: 144,
    align: 16,
  });
});

test("hashMapFmt: matches the C++ StateData layout + sizeof pin (41232)", () => {
  expect(hashMapFmt("id", "uint64", 1024)).toBe(
    "{ [1024;{ id, uint64 }], [32;uint64], uint64, uint64 }",
  );
  expect(layoutOf(hashMapFmt("id", "uint64", 1024)).size).toBe(41232); // DbgMap marker offset
});

test("hashSetFmt / collectionFmt shapes", () => {
  expect(hashSetFmt("id", 64)).toBe("{ [64;id], [2;uint64], uint64, uint64 }");
  expect(collectionFmt("uint64", 4)).toBe(
    "{ [4;{ id, uint64, sint64, sint64, sint64 }], [1;uint64], [4;{ uint64, sint64, sint64, sint64, sint64, sint64 }], uint64, uint64 }",
  );
  expect(linkedListFmt("uint64", 8)).toBe(
    "{ [8;{ uint64, sint64, sint64 }], [1;uint64], sint64, sint64, sint64, uint64, uint64 }",
  );
  expect(layoutOf(linkedListFmt("uint64", 8))).toEqual({
    size: 240,
    align: 8,
  });
});

test("element fmts (consumed by the decoders) are the single source", () => {
  expect(hashMapElemFmt("id", "uint64")).toBe("id, uint64");
  expect(COLLECTION_POV_FMT).toBe("id, uint64, sint64, sint64, sint64");
  expect(collectionElemFmt("uint64")).toBe("uint64, sint64, sint64, sint64, sint64, sint64");
});
