import { expect, test } from "bun:test";
import {
  AbiScalarKind,
  AbiTypeKind,
  QpiArrayView,
  QpiBitArrayView,
  QpiCollectionView,
  QpiContainerConsistencyError,
  QpiHashMapView,
  QpiHashSetView,
  QpiLinkedListView,
  arrayGeometry,
  bitArrayGeometry,
  collectionGeometry,
  decodeOutput,
  hashMapGeometry,
  hashSetGeometry,
  linkedListGeometry,
  qpiSnapshotSource,
  type AbiArray,
  type AbiBitArray,
  type AbiCollection,
  type AbiHashMap,
  type AbiHashSet,
  type AbiLinkedList,
  type AbiScalar,
  type AbiStruct,
  type QpiByteSource,
} from "../../src";

const uint8Type: AbiScalar = {
  kind: AbiTypeKind.SCALAR,
  scalar: AbiScalarKind.UINT8,
  size: 1,
  align: 1,
  format: "uint8",
};

const uint64Type: AbiScalar = {
  kind: AbiTypeKind.SCALAR,
  scalar: AbiScalarKind.UINT64,
  size: 8,
  align: 8,
  format: "uint64",
};

function setInt64(bytes: Uint8Array, offset: number, value: bigint | number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setBigInt64(offset, BigInt(value), true);
}

function setUint64(bytes: Uint8Array, offset: number, value: bigint | number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .setBigUint64(offset, BigInt(value), true);
}

function sourceOf(
  bytes: Uint8Array,
  maxReadLength = bytes.length || 1,
): { source: QpiByteSource; reads: Array<[number, number]> } {
  const reads: Array<[number, number]> = [];
  return {
    reads,
    source: {
      byteLength: bytes.length,
      maxReadLength,
      async read(offset, length) {
        reads.push([offset, length]);
        return bytes.slice(offset, offset + length);
      },
    },
  };
}

test("Array view preserves nested values and exposes strict indexes", async () => {
  const element: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    fields: [{ name: "value", offset: 0, size: 1, type: uint8Type }],
    size: 1,
    align: 1,
    format: "{ uint8 }",
  };
  const geometry = arrayGeometry(element, 2);
  const arrayType: AbiArray = {
    kind: AbiTypeKind.ARRAY,
    element,
    count: 2,
    size: geometry.size,
    align: geometry.align,
    format: "[2;{ uint8 }]",
  };
  const arrayBytes = Uint8Array.of(0, 9);
  const array = new QpiArrayView(arrayType, qpiSnapshotSource(arrayBytes));
  expect(await array.entries()).toEqual([
    { index: 0, value: [0], isZeroBytes: true },
    { index: 1, value: [9], isZeroBytes: false },
  ]);
  const nonZeroEntries = [];
  for await (const entry of array.nonZeroEntries()) {
    nonZeroEntries.push(entry);
  }
  expect(nonZeroEntries).toEqual([
    { index: 1, value: [9], isZeroBytes: false },
  ]);
  expect(await array.get(1)).toEqual([9]);
  await expect(array.get(2)).rejects.toBeInstanceOf(RangeError);
});

test("Array sparse entries inspect the entire encoded stride", async () => {
  const paddedElement: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    fields: [{ name: "value", offset: 0, size: 1, type: uint8Type }],
    size: 1,
    align: 8,
    format: "{ uint8 }",
  };
  const geometry = arrayGeometry(paddedElement, 2);
  const arrayType: AbiArray = {
    kind: AbiTypeKind.ARRAY,
    element: paddedElement,
    count: 2,
    size: geometry.size,
    align: geometry.align,
    format: "[2;{ uint8 }]",
  };
  const bytes = new Uint8Array(arrayType.size);
  bytes[7] = 1;

  const entries = [];
  const array = new QpiArrayView(arrayType, qpiSnapshotSource(bytes));
  for await (const entry of array.nonZeroEntries()) {
    entries.push(entry);
  }
  expect(entries).toEqual([
    { index: 0, value: [0], isZeroBytes: false },
  ]);
});

test("Array sparse entries skip zero strides before decoding", async () => {
  const malformedElement: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    fields: [{ name: "value", offset: 0, size: 8, type: uint64Type }],
    size: 1,
    align: 1,
    format: "{ uint64 }",
  };
  const geometry = arrayGeometry(malformedElement, 2);
  const arrayType: AbiArray = {
    kind: AbiTypeKind.ARRAY,
    element: malformedElement,
    count: 2,
    size: geometry.size,
    align: geometry.align,
    format: "[2;{ uint64 }]",
  };
  const array = new QpiArrayView(
    arrayType,
    qpiSnapshotSource(new Uint8Array(arrayType.size)),
  );

  const entries = [];
  for await (const entry of array.nonZeroEntries()) {
    entries.push(entry);
  }
  expect(entries).toEqual([]);
  await expect(array.entries()).rejects.toThrow();
});

test("BitArray view ignores padding and rejects invalid indexes and capacity", async () => {
  const geometry = bitArrayGeometry(16);
  const bitType: AbiBitArray = {
    kind: AbiTypeKind.BIT_ARRAY,
    bitCount: 16,
    size: geometry.size,
    align: geometry.align,
    format: "[1;uint64]",
  };
  const bitBytes = new Uint8Array(8);
  bitBytes[0] = 1;
  bitBytes[1] = 2;
  bitBytes[7] = 0x80;
  const tracked = sourceOf(bitBytes, 1);
  const bits = new QpiBitArrayView(bitType, tracked.source);
  const entries = await bits.entries();
  expect(entries).toHaveLength(16);
  expect(entries.filter((entry) => entry.value).map((entry) => entry.index))
    .toEqual([0, 9]);
  expect(tracked.reads).toEqual([[0, 1], [1, 1]]);
  const setBits = [];
  for await (const index of bits.setBits()) {
    setBits.push(index);
  }
  expect(setBits).toEqual([0, 9]);
  expect(tracked.reads).toEqual([
    [0, 1],
    [1, 1],
    [0, 1],
    [1, 1],
  ]);
  expect(await bits.get(1)).toBe(0);
  await expect(bits.get(-1)).rejects.toBeInstanceOf(RangeError);

  expect(() => new QpiBitArrayView(
    { ...bitType, bitCount: 3 },
    qpiSnapshotSource(bitBytes),
  )).toThrow("positive power of two");
});

test("HashMap view groups occupied ranges across flag words", async () => {
  const mapGeometry = hashMapGeometry(uint64Type, uint64Type, 64);
  const mapType: AbiHashMap = {
    kind: AbiTypeKind.HASH_MAP,
    key: uint64Type,
    value: uint64Type,
    capacity: 64,
    size: mapGeometry.size,
    align: mapGeometry.align,
    format: "",
  };
  const mapBytes = new Uint8Array(mapType.size);
  mapBytes[mapGeometry.flagsOffset] = 2 | (1 << 2) | (1 << 4);
  mapBytes[mapGeometry.flagsOffset + 8] = 1 << 2;
  setUint64(mapBytes, mapGeometry.populationOffset, 3);
  for (const [slot, key, value] of [
    [1, 11, 101],
    [2, 22, 202],
    [33, 66, 606],
  ]) {
    setUint64(mapBytes, slot * mapGeometry.recordStride, key);
    setUint64(
      mapBytes,
      slot * mapGeometry.recordStride + mapGeometry.valueOffset,
      value,
    );
  }
  const mapSource = sourceOf(mapBytes);
  expect(await new QpiHashMapView(mapType, mapSource.source).entries())
    .toEqual([
      { slot: 1, key: 11n, value: 101n },
      { slot: 2, key: 22n, value: 202n },
      { slot: 33, key: 66n, value: 606n },
    ]);
  expect(mapSource.reads).toEqual([
    [mapGeometry.populationOffset, 8],
    [mapGeometry.flagsOffset, mapGeometry.flagsBytes],
    [mapGeometry.recordStride, mapGeometry.recordStride * 2],
    [mapGeometry.recordStride * 33, mapGeometry.recordStride],
  ]);

  setUint64(mapBytes, mapGeometry.populationOffset, 2);
  await expect(
    new QpiHashMapView(mapType, qpiSnapshotSource(mapBytes)).entries(),
  ).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("HashSet view excludes marked-for-removal slots", async () => {
  const setGeometry = hashSetGeometry(uint64Type, 4);
  const setType: AbiHashSet = {
    kind: AbiTypeKind.HASH_SET,
    key: uint64Type,
    capacity: 4,
    size: setGeometry.size,
    align: setGeometry.align,
    format: "",
  };
  const setBytes = new Uint8Array(setType.size);
  setUint64(setBytes, setGeometry.recordStride * 3, 33);
  setBytes[setGeometry.flagsOffset] = (2 << 2) | (1 << 6);
  setUint64(setBytes, setGeometry.populationOffset, 1);
  expect(
    await new QpiHashSetView(
      setType,
      qpiSnapshotSource(setBytes),
    ).entries(),
  ).toEqual([{ slot: 3, key: 33n }]);
  expect(await decodeOutput(setBytes, setType))
    .toEqual([{ slot: 3, key: 33n }]);
});

test("Collection view validates and walks each active PoV tree", async () => {
  const geometry = collectionGeometry(uint64Type, 4);
  const type: AbiCollection = {
    kind: AbiTypeKind.COLLECTION,
    value: uint64Type,
    capacity: 4,
    size: geometry.size,
    align: geometry.align,
    format: "",
  };
  const bytes = new Uint8Array(type.size);
  bytes[geometry.flagsOffset] = 1 | (1 << 4);
  setUint64(bytes, geometry.populationOffset, 4);
  setUint64(bytes, geometry.povPopulationOffset, 3);
  setInt64(bytes, geometry.povHeadOffset, 1);
  setInt64(bytes, geometry.povTailOffset, 2);
  setInt64(bytes, geometry.povBstRootOffset, 0);

  const secondPov = geometry.povStride * 2;
  bytes[secondPov + geometry.povValueOffset] = 1;
  setUint64(bytes, secondPov + geometry.povPopulationOffset, 1);
  setInt64(bytes, secondPov + geometry.povHeadOffset, 3);
  setInt64(bytes, secondPov + geometry.povTailOffset, 3);
  setInt64(bytes, secondPov + geometry.povBstRootOffset, 3);

  const element = (
    index: number,
    value: number,
    priority: number,
    parent: number,
    left: number,
    right: number,
    pov = 0,
  ) => {
    const offset = geometry.elementsOffset + index * geometry.elementStride;
    setUint64(bytes, offset + geometry.elementValueOffset, value);
    setInt64(bytes, offset + geometry.elementPriorityOffset, priority);
    setInt64(bytes, offset + geometry.elementPovIndexOffset, pov);
    setInt64(bytes, offset + geometry.elementBstParentOffset, parent);
    setInt64(bytes, offset + geometry.elementBstLeftOffset, left);
    setInt64(bytes, offset + geometry.elementBstRightOffset, right);
  };
  element(0, 50, 5, -1, 1, 2);
  element(1, 90, 9, 0, -1, -1);
  element(2, 20, 2, 0, -1, -1);
  element(3, 70, 7, -1, -1, -1, 2);

  const entries = await new QpiCollectionView(
    type,
    qpiSnapshotSource(bytes),
  ).entries();
  expect(entries.map(({ elementIndex, priority, value }) => ({
    elementIndex,
    priority,
    value,
  }))).toEqual([
    { elementIndex: 1, priority: 9n, value: 90n },
    { elementIndex: 0, priority: 5n, value: 50n },
    { elementIndex: 2, priority: 2n, value: 20n },
    { elementIndex: 3, priority: 7n, value: 70n },
  ]);
  expect(entries.map((entry) => entry.povSlot)).toEqual([0, 0, 0, 2]);
  expect(entries[0].pov).not.toBe(entries[3].pov);
  expect(await decodeOutput(bytes, type)).toEqual(entries);

  setInt64(
    bytes,
    geometry.elementsOffset + geometry.elementStride +
      geometry.elementBstParentOffset,
    2,
  );
  await expect(
    new QpiCollectionView(type, qpiSnapshotSource(bytes)).entries(),
  ).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("LinkedList view follows logical order and rejects broken links", async () => {
  const geometry = linkedListGeometry(uint64Type, 8);
  const type: AbiLinkedList = {
    kind: AbiTypeKind.LINKED_LIST,
    value: uint64Type,
    capacity: 8,
    size: geometry.size,
    align: geometry.align,
    format: "",
  };
  const bytes = new Uint8Array(type.size);
  bytes[geometry.flagsOffset] = (1 << 1) | (1 << 2) | (1 << 6);
  setInt64(bytes, geometry.headOffset, 6);
  setInt64(bytes, geometry.tailOffset, 2);
  setUint64(bytes, geometry.populationOffset, 3);
  for (const [slot, value, next, previous] of [
    [6, 66, 1, -1],
    [1, 11, 2, 6],
    [2, 22, -1, 1],
  ]) {
    const offset = slot * geometry.nodeStride;
    setUint64(bytes, offset, value);
    setInt64(bytes, offset + geometry.nextOffset, next);
    setInt64(bytes, offset + geometry.prevOffset, previous);
  }

  expect(
    await new QpiLinkedListView(
      type,
      qpiSnapshotSource(bytes),
    ).entries(),
  ).toEqual([
    { slot: 6, value: 66n },
    { slot: 1, value: 11n },
    { slot: 2, value: 22n },
  ]);

  setInt64(bytes, geometry.nodeStride + geometry.prevOffset, 2);
  await expect(
    new QpiLinkedListView(type, qpiSnapshotSource(bytes)).entries(),
  ).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("HashMap view reads only population when empty", async () => {
  const geometry = hashMapGeometry(uint64Type, uint64Type, 4);
  const type: AbiHashMap = {
    kind: AbiTypeKind.HASH_MAP,
    key: uint64Type,
    value: uint64Type,
    capacity: 4,
    size: geometry.size,
    align: geometry.align,
    format: "",
  };
  const bytes = new Uint8Array(type.size);
  const tracked = sourceOf(bytes);
  expect(await new QpiHashMapView(type, tracked.source).entries()).toEqual([]);
  expect(tracked.reads).toEqual([[geometry.populationOffset, 8]]);
});

test("snapshot sources copy their bytes", async () => {
  const geometry = arrayGeometry(uint8Type, 1);
  const singleType: AbiArray = {
    kind: AbiTypeKind.ARRAY,
    element: uint8Type,
    count: 1,
    size: geometry.size,
    align: geometry.align,
    format: "[1;uint8]",
  };
  const original = Uint8Array.of(7);
  const snapshot = qpiSnapshotSource(original);
  original[0] = 9;
  expect(await new QpiArrayView(singleType, snapshot).get(0)).toBe(7);
});
