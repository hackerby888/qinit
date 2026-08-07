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
  collectionGeometry,
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

test("Array and BitArray views expose strict logical indexes", async () => {
  const arrayType: AbiArray = {
    kind: AbiTypeKind.ARRAY,
    element: uint8Type,
    count: 2,
    size: 2,
    align: 1,
    format: "[2;uint8]",
  };
  const arrayBytes = Uint8Array.of(0, 9);
  const array = new QpiArrayView(arrayType, qpiSnapshotSource(arrayBytes));
  expect(await array.entries()).toEqual([
    { index: 0, value: 0, isZeroBytes: true },
    { index: 1, value: 9, isZeroBytes: false },
  ]);
  expect(await array.get(1)).toBe(9);
  await expect(array.get(2)).rejects.toBeInstanceOf(RangeError);

  const bitType: AbiBitArray = {
    kind: AbiTypeKind.BIT_ARRAY,
    bitCount: 2,
    size: 8,
    align: 8,
    format: "[1;uint64]",
  };
  const bitBytes = new Uint8Array(8);
  bitBytes[0] = 1;
  bitBytes[7] = 0x80;
  const bits = new QpiBitArrayView(bitType, qpiSnapshotSource(bitBytes));
  const entries = await bits.entries();
  expect(entries).toHaveLength(2);
  expect(entries.filter((entry) => entry.value).map((entry) => entry.index))
    .toEqual([0]);
  expect(await bits.get(1)).toBe(0);
  await expect(bits.get(-1)).rejects.toBeInstanceOf(RangeError);

  expect(() => new QpiBitArrayView(
    { ...bitType, bitCount: 3 },
    qpiSnapshotSource(bitBytes),
  )).toThrow("positive power of two");
});

test("HashMap and HashSet views read only occupied record ranges", async () => {
  const mapGeometry = hashMapGeometry(uint64Type, uint64Type, 8);
  const mapType: AbiHashMap = {
    kind: AbiTypeKind.HASH_MAP,
    key: uint64Type,
    value: uint64Type,
    capacity: 8,
    size: mapGeometry.populationOffset + 16,
    align: 8,
    format: "",
  };
  const mapBytes = new Uint8Array(mapType.size);
  mapBytes[mapGeometry.flagsOffset] = (1 << 2) | (1 << 4);
  mapBytes[mapGeometry.flagsOffset + 1] = 1 << 4;
  setUint64(mapBytes, mapGeometry.populationOffset, 3);
  for (const [slot, key, value] of [
    [1, 11, 101],
    [2, 22, 202],
    [6, 66, 606],
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
      { slot: 6, key: 66n, value: 606n },
    ]);
  expect(mapSource.reads).toEqual([
    [mapGeometry.populationOffset, 8],
    [mapGeometry.flagsOffset, mapGeometry.flagsBytes],
    [mapGeometry.recordStride, mapGeometry.recordStride * 2],
    [mapGeometry.recordStride * 6, mapGeometry.recordStride],
  ]);

  const setGeometry = hashSetGeometry(uint64Type, 4);
  const setType: AbiHashSet = {
    kind: AbiTypeKind.HASH_SET,
    key: uint64Type,
    capacity: 4,
    size: setGeometry.populationOffset + 16,
    align: 8,
    format: "",
  };
  const setBytes = new Uint8Array(setType.size);
  setUint64(setBytes, setGeometry.recordStride * 3, 33);
  setBytes[setGeometry.flagsOffset] = 1 << 6;
  setUint64(setBytes, setGeometry.populationOffset, 1);
  expect(
    await new QpiHashSetView(
      setType,
      qpiSnapshotSource(setBytes),
    ).entries(),
  ).toEqual([{ slot: 3, key: 33n }]);

  setUint64(mapBytes, mapGeometry.populationOffset, 2);
  await expect(
    new QpiHashMapView(mapType, qpiSnapshotSource(mapBytes)).entries(),
  ).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("Collection view validates and walks each PoV tree", async () => {
  const geometry = collectionGeometry(uint64Type, 4);
  const type: AbiCollection = {
    kind: AbiTypeKind.COLLECTION,
    value: uint64Type,
    capacity: 4,
    size: geometry.populationOffset + 16,
    align: 8,
    format: "",
  };
  const bytes = new Uint8Array(type.size);
  bytes[geometry.flagsOffset] = 1;
  setUint64(bytes, geometry.populationOffset, 3);
  setUint64(bytes, 32, 3);
  setInt64(bytes, 40, 1);
  setInt64(bytes, 48, 2);
  setInt64(bytes, 56, 0);

  const element = (
    index: number,
    value: number,
    priority: number,
    parent: number,
    left: number,
    right: number,
  ) => {
    const offset = geometry.elementsOffset + index * geometry.elementStride;
    setUint64(bytes, offset, value);
    setInt64(bytes, offset + geometry.priorityOffset, priority);
    setInt64(bytes, offset + geometry.priorityOffset + 8, 0);
    setInt64(bytes, offset + geometry.priorityOffset + 16, parent);
    setInt64(bytes, offset + geometry.priorityOffset + 24, left);
    setInt64(bytes, offset + geometry.priorityOffset + 32, right);
  };
  element(0, 50, 5, -1, 1, 2);
  element(1, 90, 9, 0, -1, -1);
  element(2, 20, 2, 0, -1, -1);

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
  ]);
  expect(entries.every((entry) => entry.povSlot === 0)).toBe(true);

  setInt64(
    bytes,
    geometry.elementsOffset + geometry.elementStride +
      geometry.priorityOffset + 16,
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
    align: geometry.nodeAlign,
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

test("snapshot sources copy bytes and empty containers read only population", async () => {
  const geometry = hashMapGeometry(uint64Type, uint64Type, 4);
  const type: AbiHashMap = {
    kind: AbiTypeKind.HASH_MAP,
    key: uint64Type,
    value: uint64Type,
    capacity: 4,
    size: geometry.populationOffset + 16,
    align: 8,
    format: "",
  };
  const bytes = new Uint8Array(type.size);
  const tracked = sourceOf(bytes);
  expect(await new QpiHashMapView(type, tracked.source).entries()).toEqual([]);
  expect(tracked.reads).toEqual([[geometry.populationOffset, 8]]);

  const singleType: AbiArray = {
    kind: AbiTypeKind.ARRAY,
    element: uint8Type,
    count: 1,
    size: 1,
    align: 1,
    format: "[1;uint8]",
  };
  const original = Uint8Array.of(7);
  const snapshot = qpiSnapshotSource(original);
  original[0] = 9;
  expect(await new QpiArrayView(singleType, snapshot).get(0)).toBe(7);
});
