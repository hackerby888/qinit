// The container views only decode; every fixture so far had to place flag bits, records and links by
// hand, which is why they all use uint64 keys. These writers go the other way — logical entries in,
// container bytes out — so a test can state what a container holds and let the view prove it reads it.
//
// Record payloads are deterministic filler rather than encoded values, and the expected entry decodes
// the same slice the view is supposed to read. That keeps these focused on the bookkeeping the writers
// own — flags, population, stride, links, the PoV tree — and leaves value decoding to the format fuzz.
// Geometry is shared with the views on purpose: it is pinned separately against formatAbiType.
import { decodeAbiValue } from "../../src/abi-fmt";
import {
    AbiScalarKind,
    AbiTypeKind,
    type AbiBitArray,
    type AbiCollection,
    type AbiHashMap,
    type AbiHashSet,
    type AbiLinkedList,
    type AbiScalar,
} from "../../src/contract-idl";
import { bitWordCount, collectionGeometry, hashMapGeometry, hashSetGeometry, linkedListGeometry } from "../../src/qpi-layout";

const POV_TYPE: AbiScalar = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.ID, size: 32, align: 8, format: "id" };

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const setUint64 = (bytes: Uint8Array, offset: number, value: number | bigint) => view(bytes).setBigUint64(offset, BigInt(value), true);
export const setSint64 = (bytes: Uint8Array, offset: number, value: number | bigint) => view(bytes).setBigInt64(offset, BigInt(value), true);

// hash_map / hash_set / collection: two bits per slot, 1 occupied and 2 deleted. 3 is the invalid pattern
// the view rejects, so it is never written here.
export const setPairFlag = (bytes: Uint8Array, flagsOffset: number, slot: number, flag: 1 | 2) => {
    bytes[flagsOffset + (slot >> 2)] |= flag << ((slot & 3) * 2);
};

// linked_list uses one bit per slot instead, so it needs its own setter rather than the pair one above.
export const setBitFlag = (bytes: Uint8Array, flagsOffset: number, slot: number) => {
    bytes[flagsOffset + (slot >> 3)] |= 1 << (slot & 7);
};

// Distinct bytes per region, so a record read at the wrong offset decodes to a different value.
export function fill(bytes: Uint8Array, offset: number, length: number, seed: number): void {
    for (let index = 0; index < length; index++) {
        bytes[offset + index] = (seed * 131 + index * 37 + 11) & 0xff;
    }
}

const slice = (bytes: Uint8Array, offset: number, length: number) => bytes.slice(offset, offset + length);

export interface WrittenHashMap {
    bytes: Uint8Array;
    entries: { slot: number; key: unknown; value: unknown }[];
}

export async function writeHashMap(type: AbiHashMap, occupied: number[], deleted: number[] = []): Promise<WrittenHashMap> {
    const geometry = hashMapGeometry(type.key, type.value, type.capacity);
    const bytes = new Uint8Array(type.size);
    const slots = [...occupied].sort((a, b) => a - b);

    for (const slot of deleted) {
        fill(bytes, slot * geometry.recordStride, geometry.recordStride, slot + 900);
        setPairFlag(bytes, geometry.flagsOffset, slot, 2);
    }
    for (const slot of slots) {
        fill(bytes, slot * geometry.recordStride, type.key.size, slot + 1);
        fill(bytes, slot * geometry.recordStride + geometry.valueOffset, type.value.size, slot + 500);
        setPairFlag(bytes, geometry.flagsOffset, slot, 1);
    }
    setUint64(bytes, geometry.populationOffset, slots.length);

    const entries = [];
    for (const slot of slots) {
        entries.push({
            slot,
            key: await decodeAbiValue(slice(bytes, slot * geometry.recordStride, type.key.size), type.key),
            value: await decodeAbiValue(slice(bytes, slot * geometry.recordStride + geometry.valueOffset, type.value.size), type.value),
        });
    }
    return { bytes, entries };
}

export async function writeHashSet(
    type: AbiHashSet,
    occupied: number[],
    deleted: number[] = [],
): Promise<{ bytes: Uint8Array; entries: { slot: number; key: unknown }[] }> {
    const geometry = hashSetGeometry(type.key, type.capacity);
    const bytes = new Uint8Array(type.size);
    const slots = [...occupied].sort((a, b) => a - b);

    for (const slot of deleted) {
        fill(bytes, slot * geometry.recordStride, geometry.recordStride, slot + 900);
        setPairFlag(bytes, geometry.flagsOffset, slot, 2);
    }
    for (const slot of slots) {
        fill(bytes, slot * geometry.recordStride, type.key.size, slot + 1);
        setPairFlag(bytes, geometry.flagsOffset, slot, 1);
    }
    setUint64(bytes, geometry.populationOffset, slots.length);

    const entries = [];
    for (const slot of slots) {
        entries.push({ slot, key: await decodeAbiValue(slice(bytes, slot * geometry.recordStride, type.key.size), type.key) });
    }
    return { bytes, entries };
}

// `order` is the list order the view has to reconstruct from next/prev, deliberately not slot order.
export async function writeLinkedList(type: AbiLinkedList, order: number[]): Promise<{ bytes: Uint8Array; entries: { slot: number; value: unknown }[] }> {
    const geometry = linkedListGeometry(type.value, type.capacity);
    const bytes = new Uint8Array(type.size);

    for (const [position, slot] of order.entries()) {
        fill(bytes, slot * geometry.nodeStride, type.value.size, slot + 1);
        setSint64(bytes, slot * geometry.nodeStride + geometry.nextOffset, position + 1 < order.length ? order[position + 1] : -1);
        setSint64(bytes, slot * geometry.nodeStride + geometry.prevOffset, position > 0 ? order[position - 1] : -1);
        setBitFlag(bytes, geometry.flagsOffset, slot);
    }
    setSint64(bytes, geometry.headOffset, order.length ? order[0] : -1);
    setSint64(bytes, geometry.tailOffset, order.length ? order[order.length - 1] : -1);
    // The view never reads these two, but core keeps them, so the bytes stay faithful to a real state.
    setSint64(bytes, geometry.freeHeadOffset, -1);
    setUint64(bytes, geometry.nextUnusedOffset, order.length);
    setUint64(bytes, geometry.populationOffset, order.length);

    const entries = [];
    for (const slot of order) {
        entries.push({ slot, value: await decodeAbiValue(slice(bytes, slot * geometry.nodeStride, type.value.size), type.value) });
    }
    return { bytes, entries };
}

export interface CollectionPovSpec {
    slot: number;
    count: number;
}

export interface WrittenCollection {
    bytes: Uint8Array;
    entries: { povSlot: number; elementIndex: number; pov: unknown; priority: bigint; value: unknown }[];
}

// Elements are stored packed at 0..population-1 because the view reads them as one run, so each PoV owns
// a contiguous slice of that index space and holds a balanced BST over it. In-order of a balanced tree
// built from ascending indices is ascending, which is what makes head the first index and tail the last.
export async function writeCollection(type: AbiCollection, povs: CollectionPovSpec[], deleted: number[] = []): Promise<WrittenCollection> {
    const geometry = collectionGeometry(type.value, type.capacity);
    const bytes = new Uint8Array(type.size);
    const ordered = [...povs].sort((a, b) => a.slot - b.slot);
    const population = ordered.reduce((sum, pov) => sum + pov.count, 0);

    for (const slot of deleted) {
        setPairFlag(bytes, geometry.flagsOffset, slot, 2);
    }

    let nextIndex = 0;
    const ranges = ordered.map((pov) => {
        const start = nextIndex;
        nextIndex += pov.count;
        return { ...pov, start, end: nextIndex - 1 };
    });

    for (const range of ranges) {
        const povOffset = geometry.povsOffset + range.slot * geometry.povStride;
        fill(bytes, povOffset + geometry.povValueOffset, POV_TYPE.size, range.slot + 7);
        setUint64(bytes, povOffset + geometry.povPopulationOffset, range.count);
        setSint64(bytes, povOffset + geometry.povHeadOffset, range.start);
        setSint64(bytes, povOffset + geometry.povTailOffset, range.end);
        setSint64(bytes, povOffset + geometry.povBstRootOffset, (range.start + range.end) >> 1);
        setPairFlag(bytes, geometry.flagsOffset, range.slot, 1);

        for (let index = range.start; index <= range.end; index++) {
            const elementOffset = geometry.elementsOffset + index * geometry.elementStride;
            fill(bytes, elementOffset + geometry.elementValueOffset, type.value.size, index + 300);
            // Non-decreasing along the in-order walk, the way core emits them.
            setSint64(bytes, elementOffset + geometry.elementPriorityOffset, index - range.start);
            setSint64(bytes, elementOffset + geometry.elementPovIndexOffset, range.slot);
        }
        linkBst(bytes, geometry, range.start, range.end, -1);
    }
    setUint64(bytes, geometry.populationOffset, population);

    const entries = [];
    for (const range of ranges) {
        const povOffset = geometry.povsOffset + range.slot * geometry.povStride;
        const pov = await decodeAbiValue(slice(bytes, povOffset + geometry.povValueOffset, POV_TYPE.size), POV_TYPE);
        for (let index = range.start; index <= range.end; index++) {
            const elementOffset = geometry.elementsOffset + index * geometry.elementStride;
            entries.push({
                povSlot: range.slot,
                elementIndex: index,
                pov,
                priority: BigInt(index - range.start),
                value: await decodeAbiValue(slice(bytes, elementOffset + geometry.elementValueOffset, type.value.size), type.value),
            });
        }
    }
    return { bytes, entries };
}

function linkBst(bytes: Uint8Array, geometry: ReturnType<typeof collectionGeometry>, low: number, high: number, parent: number): number {
    if (low > high) {
        return -1;
    }
    const middle = (low + high) >> 1;
    const offset = geometry.elementsOffset + middle * geometry.elementStride;
    setSint64(bytes, offset + geometry.elementBstParentOffset, parent);
    setSint64(bytes, offset + geometry.elementBstLeftOffset, linkBst(bytes, geometry, low, middle - 1, middle));
    setSint64(bytes, offset + geometry.elementBstRightOffset, linkBst(bytes, geometry, middle + 1, high, middle));
    return middle;
}

export function writeBitArray(type: AbiBitArray, setBits: number[]): Uint8Array {
    const bytes = new Uint8Array(type.size);
    for (const bit of setBits) {
        bytes[bit >> 3] |= 1 << (bit & 7);
    }
    return bytes.subarray(0, bitWordCount(type.bitCount) * 8);
}
