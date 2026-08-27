// Generated container states, written by qpi-writers and read back by the views. The hand-built fixtures
// in qpi-container-view.test.ts cover shapes someone chose; these cover the slot sets, list orders and
// PoV splits nobody typed out — which is where the flag packing, the next/prev chain and the PoV tree
// stop being obvious.
import { test, expect } from "bun:test";
import { QpiCollectionView, QpiHashMapView, QpiHashSetView, QpiLinkedListView, qpiSnapshotSource } from "../../src";
import { collectionGeometry, hashMapGeometry, hashSetGeometry, linkedListGeometry } from "../../src/qpi-layout";
import { QpiContainerConsistencyError } from "../../src/qpi-container-view/errors";
import { arr, bit, co, hm, hs, i32, id, ll, m256i, st, u8, u16, u64, u128, validated } from "./abi-builders";
import { setPairFlag, setSint64, setUint64, writeCollection, writeHashMap, writeHashSet, writeLinkedList } from "./qpi-writers";
import type { AbiType } from "../../src/contract-idl";

const source = (bytes: Uint8Array) => qpiSnapshotSource(bytes);

// A tiny LCG rather than Math.random, so a failure reproduces from the seed the message carries.
function rng(seed: number): () => number {
    let state = (seed * 2654435761) >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const PAYLOADS: [name: string, type: AbiType][] = [
    ["uint8", u8],
    ["uint64", u64],
    ["uint128", u128],
    ["id", id],
    ["m256i", m256i],
    ["bit", bit],
    ["{ uint8, uint64 }", st(u8, u64)],
    ["{ uint16, sint32, uint8 }", st(u16, i32, u8)],
    ["[2;uint64]", arr(u64, 2)],
    ["{ [2;uint8], id }", st(arr(u8, 2), id)],
];

const CAPACITIES = [1, 2, 4, 8, 32, 64];

// Pick `count` distinct slots below `capacity`, spread rather than contiguous so the view's range
// grouping has both runs and gaps to handle.
function pickSlots(next: () => number, capacity: number, count: number): number[] {
    const slots = new Set<number>();
    while (slots.size < count) {
        slots.add(Math.floor(next() * capacity));
    }
    return [...slots].sort((a, b) => a - b);
}

const shuffle = <T>(next: () => number, items: T[]): T[] => {
    const out = [...items];
    for (let index = out.length - 1; index > 0; index--) {
        const swap = Math.floor(next() * (index + 1));
        [out[index], out[swap]] = [out[swap], out[index]];
    }
    return out;
};

test("a generated HashMap reads back exactly the entries it was written with", async () => {
    let checked = 0;
    for (let seed = 1; seed <= 120; seed++) {
        const next = rng(seed);
        const key = PAYLOADS[Math.floor(next() * PAYLOADS.length)][1];
        const value = PAYLOADS[Math.floor(next() * PAYLOADS.length)][1];
        const capacity = CAPACITIES[Math.floor(next() * CAPACITIES.length)];
        const type = validated(hm(key, value, capacity));

        const used = Math.floor(next() * (capacity + 1));
        const slots = pickSlots(next, capacity, used);
        const free = [...Array(capacity).keys()].filter((slot) => !slots.includes(slot));
        const deleted = free.slice(0, Math.floor(next() * Math.min(3, free.length + 1)));

        const written = await writeHashMap(type, slots, deleted);
        const read = await new QpiHashMapView(type, source(written.bytes)).entries();
        expect({ seed, capacity, used, entries: read }).toEqual({ seed, capacity, used, entries: written.entries });
        checked++;
    }
    expect(checked).toBe(120);
});

test("a generated HashSet reads back exactly the keys it was written with", async () => {
    for (let seed = 1; seed <= 100; seed++) {
        const next = rng(seed + 4000);
        const key = PAYLOADS[Math.floor(next() * PAYLOADS.length)][1];
        const capacity = CAPACITIES[Math.floor(next() * CAPACITIES.length)];
        const type = validated(hs(key, capacity));

        const used = Math.floor(next() * (capacity + 1));
        const slots = pickSlots(next, capacity, used);
        const free = [...Array(capacity).keys()].filter((slot) => !slots.includes(slot));
        const deleted = free.slice(0, Math.floor(next() * Math.min(3, free.length + 1)));

        const written = await writeHashSet(type, slots, deleted);
        const read = await new QpiHashSetView(type, source(written.bytes)).entries();
        expect({ seed, capacity, entries: read }).toEqual({ seed, capacity, entries: written.entries });
    }
});

test("a generated LinkedList reads back in list order, not slot order", async () => {
    let sawOutOfOrder = false;
    for (let seed = 1; seed <= 120; seed++) {
        const next = rng(seed + 8000);
        const value = PAYLOADS[Math.floor(next() * PAYLOADS.length)][1];
        const capacity = CAPACITIES[Math.floor(next() * CAPACITIES.length)];
        const type = validated(ll(value, capacity));

        const used = Math.floor(next() * (capacity + 1));
        const order = shuffle(next, pickSlots(next, capacity, used));
        if (order.some((slot, index) => index > 0 && slot < order[index - 1])) {
            sawOutOfOrder = true;
        }

        const written = await writeLinkedList(type, order);
        const read = await new QpiLinkedListView(type, source(written.bytes)).entries();
        expect({ seed, capacity, order, entries: read }).toEqual({ seed, capacity, order, entries: written.entries });
        expect(read.map((entry) => entry.slot)).toEqual(order);
    }
    // The property is worthless if every generated chain happened to run in slot order.
    expect(sawOutOfOrder).toBe(true);
});

test("a generated Collection reads back in PoV then priority order", async () => {
    let sawMultiPov = false;
    for (let seed = 1; seed <= 100; seed++) {
        const next = rng(seed + 12000);
        const value = PAYLOADS[Math.floor(next() * PAYLOADS.length)][1];
        const capacity = CAPACITIES[Math.floor(next() * CAPACITIES.length)];
        const type = validated(co(value, capacity));

        const povCount = 1 + Math.floor(next() * Math.min(3, capacity));
        const povSlots = pickSlots(next, capacity, povCount);
        // Every element sits in the packed 0..population-1 run, so the counts have to fit the capacity.
        let remaining = capacity;
        const povs = povSlots.map((slot, index) => {
            const most = remaining - (povSlots.length - index - 1);
            const count = 1 + Math.floor(next() * Math.max(1, Math.min(most - 1, 4)));
            remaining -= count;
            return { slot, count };
        });
        if (povs.length > 1) {
            sawMultiPov = true;
        }

        const written = await writeCollection(type, povs);
        const read = await new QpiCollectionView(type, source(written.bytes)).entries();
        expect({ seed, capacity, povs, entries: read }).toEqual({ seed, capacity, povs, entries: written.entries });
    }
    expect(sawMultiPov).toBe(true);
});

// One corruption per kind, each a single field flipped on an otherwise valid state. The writer is what
// makes these cheap: build a container the view accepts, then break exactly one thing.
test("a HashMap whose population disagrees with its flags is rejected", async () => {
    const type = validated(hm(u64, u64, 8));
    const written = await writeHashMap(type, [1, 3, 6]);
    const geometry = hashMapGeometry(type.key, type.value, type.capacity);

    setUint64(written.bytes, geometry.populationOffset, 2);
    await expect(new QpiHashMapView(type, source(written.bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("a HashSet with the invalid occupation pattern is rejected", async () => {
    const type = validated(hs(u64, 8));
    const written = await writeHashSet(type, [0, 2]);
    const geometry = hashSetGeometry(type.key, type.capacity);

    // Flag 1 already sits at slot 2, so adding 2 makes the pattern 3 the view refuses.
    setPairFlag(written.bytes, geometry.flagsOffset, 2, 2);
    await expect(new QpiHashSetView(type, source(written.bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("a LinkedList with a broken previous link is rejected", async () => {
    const type = validated(ll(u64, 8));
    const order = [5, 1, 6];
    const written = await writeLinkedList(type, order);
    const geometry = linkedListGeometry(type.value, type.capacity);

    setSint64(written.bytes, order[2] * geometry.nodeStride + geometry.prevOffset, order[0]);
    await expect(new QpiLinkedListView(type, source(written.bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("a LinkedList whose tail is not the end of its chain is rejected", async () => {
    const type = validated(ll(u64, 8));
    const written = await writeLinkedList(type, [5, 1, 6]);
    const geometry = linkedListGeometry(type.value, type.capacity);

    setSint64(written.bytes, geometry.tailOffset, 1);
    await expect(new QpiLinkedListView(type, source(written.bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("a Collection element pointing at the wrong parent is rejected", async () => {
    const type = validated(co(u64, 8));
    const written = await writeCollection(type, [{ slot: 2, count: 5 }]);
    const geometry = collectionGeometry(type.value, type.capacity);

    setSint64(written.bytes, geometry.elementsOffset + 0 * geometry.elementStride + geometry.elementBstParentOffset, 3);
    await expect(new QpiCollectionView(type, source(written.bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});

test("a Collection PoV whose population does not match its subtree is rejected", async () => {
    const type = validated(co(u64, 8));
    const written = await writeCollection(type, [{ slot: 2, count: 5 }]);
    const geometry = collectionGeometry(type.value, type.capacity);

    setUint64(written.bytes, geometry.povsOffset + 2 * geometry.povStride + geometry.povPopulationOffset, 4);
    await expect(new QpiCollectionView(type, source(written.bytes)).entries()).rejects.toBeInstanceOf(QpiContainerConsistencyError);
});
