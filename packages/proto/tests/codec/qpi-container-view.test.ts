import { expect, test } from "bun:test";
import {
    AbiScalarKind,
    AbiTypeKind,
    QpiArrayView,
    QpiBitArrayView,
    QpiCollectionView,
    QpiContainerConsistencyError,
    QpiIncompleteReadError,
    createQpiContainerView,
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
import { bytesToIdentity } from "@qinit/core";
import { decodeAbiValue } from "../../src/abi-fmt";
import { arr, ba, co, hm, id, ll, st, u8, u16, u64, u128, validated } from "./abi-builders";

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
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigInt64(offset, BigInt(value), true);
}

function setUint64(bytes: Uint8Array, offset: number, value: bigint | number) {
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, BigInt(value), true);
}

function sourceOf(bytes: Uint8Array, maxReadLength = bytes.length || 1): { source: QpiByteSource; reads: Array<[number, number]> } {
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
    expect(nonZeroEntries).toEqual([{ index: 1, value: [9], isZeroBytes: false }]);
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
    expect(entries).toEqual([{ index: 0, value: [0], isZeroBytes: false }]);
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
    const array = new QpiArrayView(arrayType, qpiSnapshotSource(new Uint8Array(arrayType.size)));

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
    expect(entries.filter((entry) => entry.value).map((entry) => entry.index)).toEqual([0, 9]);
    expect(tracked.reads).toEqual([
        [0, 1],
        [1, 1],
    ]);
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

    expect(() => new QpiBitArrayView({ ...bitType, bitCount: 3 }, qpiSnapshotSource(bitBytes))).toThrow("positive power of two");
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
        setUint64(mapBytes, slot * mapGeometry.recordStride + mapGeometry.valueOffset, value);
    }
    const mapSource = sourceOf(mapBytes);
    expect(await new QpiHashMapView(mapType, mapSource.source).entries()).toEqual([
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
    await expect(new QpiHashMapView(mapType, qpiSnapshotSource(mapBytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
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
    expect(await new QpiHashSetView(setType, qpiSnapshotSource(setBytes)).entries()).toEqual([{ slot: 3, key: 33n }]);
    expect(await decodeOutput(setBytes, setType)).toEqual([{ slot: 3, key: 33n }]);
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

    const element = (index: number, value: number, priority: number, parent: number, left: number, right: number, pov = 0) => {
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

    const entries = await new QpiCollectionView(type, qpiSnapshotSource(bytes)).entries();
    expect(
        entries.map(({ elementIndex, priority, value }) => ({
            elementIndex,
            priority,
            value,
        })),
    ).toEqual([
        { elementIndex: 1, priority: 9n, value: 90n },
        { elementIndex: 0, priority: 5n, value: 50n },
        { elementIndex: 2, priority: 2n, value: 20n },
        { elementIndex: 3, priority: 7n, value: 70n },
    ]);
    expect(entries.map((entry) => entry.povSlot)).toEqual([0, 0, 0, 2]);
    expect(entries[0].pov).not.toBe(entries[3].pov);
    expect(await decodeOutput(bytes, type)).toEqual(entries);

    setInt64(bytes, geometry.elementsOffset + geometry.elementStride + geometry.elementBstParentOffset, 2);
    await expect(new QpiCollectionView(type, qpiSnapshotSource(bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
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

    expect(await new QpiLinkedListView(type, qpiSnapshotSource(bytes)).entries()).toEqual([
        { slot: 6, value: 66n },
        { slot: 1, value: 11n },
        { slot: 2, value: 22n },
    ]);

    setInt64(bytes, geometry.nodeStride + geometry.prevOffset, 2);
    await expect(new QpiLinkedListView(type, qpiSnapshotSource(bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
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

// Real system contracts hold containers of hundreds of megabytes, and listing one used to cost a walk of
// the whole capacity however few entries it held. A sparse source keeps that testable: bytes are zero
// unless a case seeded them, so a 545 MB container never has to be allocated.
function sparseSourceOf(byteLength: number, seeded: Map<number, number>, maxReadLength = 4 * 1024 * 1024): QpiByteSource {
    return {
        byteLength,
        maxReadLength,
        async read(offset, length) {
            const bytes = new Uint8Array(length);
            for (let index = 0; index < length; index++) {
                bytes[index] = seeded.get(offset + index) ?? 0;
            }
            return bytes;
        },
    };
}

function seedUint64(seeded: Map<number, number>, offset: number, value: bigint | number) {
    let rest = BigInt(value);
    for (let index = 0; index < 8; index++) {
        seeded.set(offset + index, Number(rest & 0xffn));
        rest >>= 8n;
    }
}

const seedFlag = (seeded: Map<number, number>, flagsOffset: number, slot: number, value: number) => {
    const at = flagsOffset + ((slot * 2) >> 3);
    seeded.set(at, (seeded.get(at) ?? 0) | (value << ((slot * 2) & 7)));
};

const HUGE_CAPACITY = 1 << 25; // 33.5M slots — 536 MB of records and 8 MiB of occupation flags

test("HashMap view lists a sparse 545 MB map without walking every slot", async () => {
    const geometry = hashMapGeometry(uint64Type, uint64Type, HUGE_CAPACITY);
    const type: AbiHashMap = {
        kind: AbiTypeKind.HASH_MAP,
        key: uint64Type,
        value: uint64Type,
        capacity: HUGE_CAPACITY,
        size: geometry.size,
        align: geometry.align,
        format: "",
    };

    const seeded = new Map<number, number>();
    const slots = [0, 9822, HUGE_CAPACITY - 1];
    for (const [index, slot] of slots.entries()) {
        seedUint64(seeded, slot * geometry.recordStride, 100 + index);
        seedUint64(seeded, slot * geometry.recordStride + geometry.valueOffset, 200 + index);
        seedFlag(seeded, geometry.flagsOffset, slot, 1);
    }
    seedUint64(seeded, geometry.populationOffset, slots.length);

    const started = performance.now();
    const entries = await new QpiHashMapView(type, sparseSourceOf(type.size, seeded)).entries();

    expect(entries).toEqual([
        { slot: 0, key: 100n, value: 200n },
        { slot: 9822, key: 101n, value: 201n },
        { slot: HUGE_CAPACITY - 1, key: 102n, value: 202n },
    ]);
    // One flag word read per 32 slots rather than one per slot. Against this source the old scan takes
    // ~2700 ms and the current one ~150 ms, so the bound sits well clear of both.
    expect(performance.now() - started).toBeLessThan(1000);
});

test("HashSet view lists a sparse large set by slot", async () => {
    const capacity = 1 << 22;
    const geometry = hashSetGeometry(uint64Type, capacity);
    const type: AbiHashSet = {
        kind: AbiTypeKind.HASH_SET,
        key: uint64Type,
        capacity,
        size: geometry.size,
        align: geometry.align,
        format: "",
    };

    const seeded = new Map<number, number>();
    const slots = [0, 300_000, capacity - 1];
    for (const [index, slot] of slots.entries()) {
        seedUint64(seeded, slot * geometry.recordStride, 70 + index);
        seedFlag(seeded, geometry.flagsOffset, slot, 1);
    }
    seedUint64(seeded, geometry.populationOffset, slots.length);

    expect(await new QpiHashSetView(type, sparseSourceOf(type.size, seeded)).entries()).toEqual([
        { slot: 0, key: 70n },
        { slot: 300_000, key: 71n },
        { slot: capacity - 1, key: 72n },
    ]);
});

// Skipping empty flag words must not skip a broken one: an 0b11 pair still has to be caught, and named by
// the slot it sits in rather than by the word it shares.
test("HashMap view still rejects an invalid flag in a populated word", async () => {
    const capacity = 1 << 20;
    const geometry = hashMapGeometry(uint64Type, uint64Type, capacity);
    const type: AbiHashMap = {
        kind: AbiTypeKind.HASH_MAP,
        key: uint64Type,
        value: uint64Type,
        capacity,
        size: geometry.size,
        align: geometry.align,
        format: "",
    };

    const seeded = new Map<number, number>();
    seedFlag(seeded, geometry.flagsOffset, 500_000, 1);
    seedFlag(seeded, geometry.flagsOffset, 500_003, 3);
    seedUint64(seeded, geometry.populationOffset, 1);

    await expect(new QpiHashMapView(type, sparseSourceOf(type.size, seeded)).entries()).rejects.toThrow("invalid occupation flag at slot 500003");
});

// A capacity below one flag word leaves bits past the end of the container. They are not slots, and a
// stale one must not turn into an entry.
test("HashMap view ignores flag bits past a capacity shorter than one word", async () => {
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
    bytes[geometry.flagsOffset] = 1 << 2; // slot 1
    bytes[geometry.flagsOffset + 1] = 1; // slot 4, one past the last
    setUint64(bytes, geometry.recordStride, 11);
    setUint64(bytes, geometry.recordStride + geometry.valueOffset, 101);
    setUint64(bytes, geometry.populationOffset, 1);

    expect(await new QpiHashMapView(type, qpiSnapshotSource(bytes)).entries()).toEqual([{ slot: 1, key: 11n, value: 101n }]);
});

// ---- containers nested inside containers: no fixture above reaches past one container level ----
const setNested = {
    u64: (bytes: Uint8Array, offset: number, value: bigint | number) => setUint64(bytes, offset, value),
    i64: (bytes: Uint8Array, offset: number, value: bigint | number) => setInt64(bytes, offset, value),
};

// HashMap<struct{ Array<id,2>; uint64 }, LinkedList<uint64,2>, 2> — a struct key holding an id array,
// and a value that is itself a container with its own flags, links and population.
const NESTED_KEY = st(arr(id, 2), u64);
const NESTED_VALUE = ll(u64, 2);
const NESTED_MAP = validated(hm(NESTED_KEY, NESTED_VALUE, 2));
const nestedMapGeometry = hashMapGeometry(NESTED_KEY, NESTED_VALUE, 2);
const nestedListGeometry = linkedListGeometry(u64, 2);

// Slot 1 holds owners [id(1), id(2)] / 99, and a two-node list whose logical order is node 1 then node 0.
function nestedMapBytes(): Uint8Array {
    const bytes = new Uint8Array(NESTED_MAP.size);
    const record = nestedMapGeometry.recordStride; // slot 1
    bytes[record] = 1;
    bytes[record + 32] = 2;
    setNested.u64(bytes, record + 64, 99);

    const list = record + nestedMapGeometry.valueOffset;
    setNested.u64(bytes, list, 9);
    setNested.i64(bytes, list + nestedListGeometry.nextOffset, -1);
    setNested.i64(bytes, list + nestedListGeometry.prevOffset, 1);
    setNested.u64(bytes, list + nestedListGeometry.nodeStride, 7);
    setNested.i64(bytes, list + nestedListGeometry.nodeStride + nestedListGeometry.nextOffset, 0);
    setNested.i64(bytes, list + nestedListGeometry.nodeStride + nestedListGeometry.prevOffset, -1);
    setNested.u64(bytes, list + nestedListGeometry.flagsOffset, 3); // both nodes occupied, one bit each
    setNested.i64(bytes, list + nestedListGeometry.headOffset, 1);
    setNested.i64(bytes, list + nestedListGeometry.tailOffset, 0);
    setNested.u64(bytes, list + nestedListGeometry.populationOffset, 2);

    setNested.u64(bytes, nestedMapGeometry.flagsOffset, 4); // slot 1 occupied: two bits per slot
    setNested.u64(bytes, nestedMapGeometry.populationOffset, 1);
    return bytes;
}

const identityOfFirstByte = async (byte: number) => bytesToIdentity(Uint8Array.of(byte, ...new Uint8Array(31)));

test("a HashMap with a struct key and a LinkedList value decodes both nestings", async () => {
    expect(NESTED_MAP.size).toBe(360);

    expect(await decodeAbiValue(nestedMapBytes(), NESTED_MAP)).toEqual([
        {
            slot: 1,
            key: [[await identityOfFirstByte(1), await identityOfFirstByte(2)], 99n],
            value: [
                { slot: 1, value: 7n }, // logical order, not slot order
                { slot: 0, value: 9n },
            ],
        },
    ]);
});

test("an inconsistent nested container fails from inside the outer one", async () => {
    const badPopulation = nestedMapBytes();
    setNested.u64(badPopulation, nestedMapGeometry.populationOffset, 2);
    await expect(decodeAbiValue(badPopulation, NESTED_MAP)).rejects.toThrow(/HashMap has 1 occupied slots but population 2/);

    const badHead = nestedMapBytes();
    setNested.i64(badHead, nestedMapGeometry.recordStride + nestedMapGeometry.valueOffset + nestedListGeometry.headOffset, 0);
    await expect(decodeAbiValue(badHead, NESTED_MAP)).rejects.toThrow(/LinkedList slot 0 has previous 1, expected -1/);

    await expect(decodeAbiValue(nestedMapBytes().slice(0, NESTED_MAP.size - 1), NESTED_MAP)).rejects.toThrow(RangeError);
});

// Collection<struct{ BitArray<64>; uint128 }, 2> — the PoV table, the element trailer, and a value
// whose 8-byte alignment carries a 16-byte member.
const COLLECTION_ELEMENT = st(ba(64), u128);
const NESTED_COLLECTION = validated(co(COLLECTION_ELEMENT, 2));
const nestedCollectionGeometry = collectionGeometry(COLLECTION_ELEMENT, 2);

// One PoV with two elements; the BST puts element 1 (priority 2) before element 0 (priority 5).
function nestedCollectionBytes(): Uint8Array {
    const bytes = new Uint8Array(NESTED_COLLECTION.size);
    bytes[nestedCollectionGeometry.povValueOffset] = 3;
    setNested.u64(bytes, nestedCollectionGeometry.povPopulationOffset, 2);
    setNested.i64(bytes, nestedCollectionGeometry.povHeadOffset, 1);
    setNested.i64(bytes, nestedCollectionGeometry.povTailOffset, 0);
    setNested.i64(bytes, nestedCollectionGeometry.povBstRootOffset, 0);
    setNested.u64(bytes, nestedCollectionGeometry.flagsOffset, 1);

    const first = nestedCollectionGeometry.elementsOffset;
    const second = first + nestedCollectionGeometry.elementStride;
    setNested.u64(bytes, first, 0b101); // bits 0 and 2 set, LSB-first
    setNested.u64(bytes, first + 8, 5); // uint128 low limb
    setNested.i64(bytes, first + nestedCollectionGeometry.elementPriorityOffset, 5);
    setNested.i64(bytes, first + nestedCollectionGeometry.elementBstParentOffset, -1);
    setNested.i64(bytes, first + nestedCollectionGeometry.elementBstLeftOffset, 1);
    setNested.i64(bytes, first + nestedCollectionGeometry.elementBstRightOffset, -1);

    setNested.u64(bytes, second + 16, 1); // uint128 HIGH limb: 2^64, so limb order survives the nesting
    setNested.i64(bytes, second + nestedCollectionGeometry.elementPriorityOffset, 2);
    setNested.i64(bytes, second + nestedCollectionGeometry.elementBstParentOffset, 0);
    setNested.i64(bytes, second + nestedCollectionGeometry.elementBstLeftOffset, -1);
    setNested.i64(bytes, second + nestedCollectionGeometry.elementBstRightOffset, -1);

    setNested.u64(bytes, nestedCollectionGeometry.populationOffset, 2);
    return bytes;
}

test("a Collection of a struct holding a BitArray and a uint128 walks the PoV tree in priority order", async () => {
    expect(NESTED_COLLECTION.size).toBe(280);

    const entries = (await decodeAbiValue(nestedCollectionBytes(), NESTED_COLLECTION)) as {
        povSlot: number;
        pov: string;
        elementIndex: number;
        priority: bigint;
        value: [number[], bigint];
    }[];

    expect(entries.map((entry) => [entry.povSlot, entry.elementIndex, entry.priority])).toEqual([
        [0, 1, 2n],
        [0, 0, 5n],
    ]);
    expect(entries[0].pov).toBe(await identityOfFirstByte(3));
    expect(entries[0].value[0]).toEqual(new Array(64).fill(0));
    expect(entries[0].value[1]).toBe(1n << 64n);

    expect(entries[1].value[0].length).toBe(64);
    expect(entries[1].value[0].filter((bitValue) => bitValue === 1).length).toBe(2);
    expect([entries[1].value[0][0], entries[1].value[0][2]]).toEqual([1, 1]);
    expect(entries[1].value[1]).toBe(5n);
});

test("a broken Collection element tree is rejected rather than partially walked", async () => {
    const badParent = nestedCollectionBytes();
    setNested.i64(
        badParent,
        nestedCollectionGeometry.elementsOffset + nestedCollectionGeometry.elementStride + nestedCollectionGeometry.elementBstParentOffset,
        -1,
    );
    await expect(decodeAbiValue(badParent, NESTED_COLLECTION)).rejects.toThrow(/Collection element 1 has parent -1, expected 0/);
});

test("an array of HashMap of BitArray decodes an empty inner container as no entries", async () => {
    const inner = hm(id, ba(64), 2);
    const type = validated(arr(inner, 2));
    const geometry = hashMapGeometry(id, ba(64), 2);
    expect(type.size).toBe(208);

    const bytes = new Uint8Array(type.size);
    const second = inner.size; // the first map stays all zero
    bytes[second] = 7;
    setNested.u64(bytes, second + geometry.valueOffset, 0b1011);
    setNested.u64(bytes, second + geometry.flagsOffset, 1);
    setNested.u64(bytes, second + geometry.populationOffset, 1);

    const decoded = (await decodeAbiValue(bytes, type)) as { slot: number; key: string; value: number[] }[][];
    expect(decoded[0]).toEqual([]); // an empty map is no entries, not one null entry
    expect(decoded[1].length).toBe(1);
    expect(decoded[1][0].slot).toBe(0);
    expect(decoded[1][0].key).toBe(await identityOfFirstByte(7));
    expect(decoded[1][0].value.slice(0, 4)).toEqual([1, 1, 0, 1]);

    const badFlag = bytes.slice();
    setNested.u64(badFlag, second + geometry.flagsOffset, 3);
    await expect(decodeAbiValue(badFlag, type)).rejects.toThrow(/invalid occupation flag at slot 0/);
});

test("a container can be a HashMap key, a struct field, and a LinkedList value", async () => {
    const innerMap = hm(u8, u8, 2);
    const keyedByMap = validated(hm(innerMap, u8, 2));
    const outerGeometry = hashMapGeometry(innerMap, u8, 2);
    const keyedBytes = new Uint8Array(keyedByMap.size);
    keyedBytes[outerGeometry.valueOffset] = 42;
    setNested.u64(keyedBytes, outerGeometry.flagsOffset, 1);
    setNested.u64(keyedBytes, outerGeometry.populationOffset, 1);
    expect(await decodeAbiValue(keyedBytes, keyedByMap)).toEqual([{ slot: 0, key: [], value: 42 }]);

    const withNeighbours = validated(st(u8, hm(u8, u64, 2), u16)) as AbiStruct;
    const fieldGeometry = hashMapGeometry(u8, u64, 2);
    expect(withNeighbours.fields.map((field) => field.offset)).toEqual([0, 8, 64]);
    const structBytes = new Uint8Array(withNeighbours.size);
    structBytes[0] = 7;
    structBytes[8] = 1;
    setNested.u64(structBytes, 8 + fieldGeometry.valueOffset, 2);
    setNested.u64(structBytes, 8 + fieldGeometry.flagsOffset, 1);
    setNested.u64(structBytes, 8 + fieldGeometry.populationOffset, 1);
    new DataView(structBytes.buffer).setUint16(64, 513, true);
    expect(await decodeAbiValue(structBytes, withNeighbours)).toEqual([7, [{ slot: 0, key: 1, value: 2n }], 513]);

    const listOfMaps = validated(ll(innerMap, 2));
    const listGeometry = linkedListGeometry(innerMap, 2);
    const innerGeometry = hashMapGeometry(u8, u8, 2);
    const listBytes = new Uint8Array(listOfMaps.size);
    listBytes[0] = 1;
    listBytes[innerGeometry.valueOffset] = 2;
    setNested.u64(listBytes, innerGeometry.flagsOffset, 1);
    setNested.u64(listBytes, innerGeometry.populationOffset, 1);
    setNested.i64(listBytes, listGeometry.nextOffset, -1);
    setNested.i64(listBytes, listGeometry.prevOffset, -1);
    setNested.u64(listBytes, listGeometry.flagsOffset, 1);
    setNested.i64(listBytes, listGeometry.headOffset, 0);
    setNested.i64(listBytes, listGeometry.tailOffset, 0);
    setNested.u64(listBytes, listGeometry.populationOffset, 1);
    expect(await decodeAbiValue(listBytes, listOfMaps)).toEqual([{ slot: 0, value: [{ slot: 0, key: 1, value: 2 }] }]);
});

test("a nested container view refuses a source shorter than the container it describes", () => {
    const bytes = nestedMapBytes();
    for (const cut of [NESTED_MAP.size - 1, nestedMapGeometry.populationOffset, 8, 0]) {
        expect(() => createQpiContainerView(NESTED_MAP, qpiSnapshotSource(bytes.slice(0, cut)))).toThrow(QpiIncompleteReadError);
    }
    expect(() => createQpiContainerView(NESTED_COLLECTION, qpiSnapshotSource(nestedCollectionBytes().slice(0, NESTED_COLLECTION.size - 1)))).toThrow(
        QpiIncompleteReadError,
    );
});
