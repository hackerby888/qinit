// The resolver had only ever met containers small enough to fit in one or two 256-byte windows. Real
// contracts run to hundreds of megabytes, where the occupation flags alone span thousands of them.
import { test, expect } from "bun:test";
import { extractIdl } from "@qinit/build";
import type { DebugStateRegion } from "@qinit/core";
import { collectionGeometry, hashMapGeometry, hashSetGeometry, linkedListGeometry } from "@qinit/proto/qpi-layout";
import { stateFieldsOf, type StateField } from "../../src/trace/state-format";
import { stateDiffLines } from "../../src/trace/state-diff";

const U64 = { size: 8, align: 8 };

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function writeLe(bytes: Uint8Array, offset: number, value: number, width = 8) {
    let rest = BigInt(value);
    for (let index = 0; index < width; index++) {
        bytes[offset + index] = Number(rest & 0xffn);
        rest >>= 8n;
    }
}

// A window carries its own bytes, so a case can sit anywhere in a 545 MB state without allocating one.
// `seed` fills the before image and `write` the after image, both at offsets relative to the window.
function diffWindow(off: number, length: number, seed?: (bytes: Uint8Array) => void, write?: (bytes: Uint8Array) => void): DebugStateRegion {
    const before = new Uint8Array(length);
    seed?.(before);

    const after = before.slice();
    write?.(after);

    return { off, before: hex(before), after: hex(after) };
}

function fieldsOf(name: string, members: string): StateField[] {
    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { ${members} };
  INITIALIZE() {}
};`;

    return stateFieldsOf(extractIdl(source, name, { slot: 7 }));
}

const offsetOf = (fields: StateField[], name: string) => fields.find((field) => field.name === name)!.off;

const rowsFor = async (fields: StateField[], regions: DebugStateRegion[]) =>
    (await stateDiffLines(fields, regions)).map((line) => `${line.label} ${line.text}`);

// Keyed containers pack 0b00 free, 0b01 occupied, 0b10 marked for removal into two bits per slot; a
// list's occupied flags take one. Both runs are addressed the same way, by index rather than by word.
const packedByte = (flagsOff: number, index: number, bitsPer: number) => flagsOff + ((index * bitsPer) >> 3);
const packedBits = (index: number, bitsPer: number, value: number) => value << ((index * bitsPer) & 7);

const flagByte = (flagsOff: number, slot: number) => packedByte(flagsOff, slot, 2);
const flagBits = (slot: number, value: number) => packedBits(slot, 2, value);

const HUGE_CAPACITY = 1 << 25; // 33.5M slots — 536 MB of records, then 8 MiB of occupation flags
const HUGE = hashMapGeometry(U64, U64, HUGE_CAPACITY);
const HUGE_FIELDS = fieldsOf("Huge", `HashMap<uint64, uint64, ${HUGE_CAPACITY}> m;`);
const HUGE_FLAGS = offsetOf(HUGE_FIELDS, "m") + HUGE.flagsOffset;

// At this capacity the flags start 512 MB into the state and span 32768 windows, so a slot's flag almost
// never lands in the window the run begins in — the shape every container in the old suite was too small
// to produce.
test("a flag deep inside a 545 MB map still reports its slot", async () => {
    for (const slot of [9822, 1_000_000, HUGE_CAPACITY - 1]) {
        const window = diffWindow(flagByte(HUGE_FLAGS, slot), 1, undefined, (bytes) => (bytes[0] = flagBits(slot, 1)));

        expect(await rowsFor(HUGE_FIELDS, [window])).toEqual([`m._occupationFlags[${slot}] 0 → 1`]);
    }
});

// Reporting a window used to cost a walk of the whole capacity, since only the bounds check inside
// `valueAt` stopped it. These same 64 rows took about 11 seconds at this size.
test("resolving 64 flag windows does not walk the whole capacity", async () => {
    const windows = Array.from({ length: 64 }, (_, index) => diffWindow(HUGE_FLAGS + 4096 + index * 512, 256, undefined, (bytes) => (bytes[0] = 1)));

    const started = performance.now();
    const rows = await rowsFor(HUGE_FIELDS, windows);

    expect(rows).toHaveLength(64);
    expect(performance.now() - started).toBeLessThan(3000);
});

// A uint32 value under a uint64 key leaves four pad bytes at the end of every record. They used to
// resolve back to the record base — the key — and report it once per pad byte, four rows of noise.
const NARROW_CAPACITY = 8;
const NARROW = hashMapGeometry(U64, { size: 4, align: 4 }, NARROW_CAPACITY);
const NARROW_FIELDS = fieldsOf("Narrow", `HashMap<uint64, uint32, ${NARROW_CAPACITY}> narrow;`);

test("a record's trailing pad reports nothing instead of re-reading its key", async () => {
    const base = offsetOf(NARROW_FIELDS, "narrow");
    const slot = 4;
    const record = slot * NARROW.recordStride;

    const window = diffWindow(base, NARROW.populationOffset + 8, undefined, (bytes) => {
        writeLe(bytes, record, 11);
        writeLe(bytes, record + NARROW.valueOffset, 5, 4);
        bytes[flagByte(NARROW.flagsOffset, slot)] = flagBits(slot, 1);
        writeLe(bytes, NARROW.populationOffset, 1);
    });

    expect(await rowsFor(NARROW_FIELDS, [window])).toEqual([
        "narrow.slot[4].key 0 → 11",
        "narrow[11] = 5 (new)",
        "narrow._occupationFlags[4] 0 → 1",
        "narrow 0 → 1 entries",
    ]);
});

// Every packed run in QPI, at a capacity that puts the changed window well past the run's first block.
const SET_CAPACITY = 1 << 19;
const LIST_CAPACITY = 1 << 18;
const QUEUE_CAPACITY = 1 << 16;
const BIT_COUNT = 1 << 22;
const SET = hashSetGeometry(U64, SET_CAPACITY);
const LIST = linkedListGeometry(U64, LIST_CAPACITY);
const QUEUE = collectionGeometry(U64, QUEUE_CAPACITY);
const WIDE_FIELDS = fieldsOf(
    "Wide",
    `HashSet<uint64, ${SET_CAPACITY}> s; LinkedList<uint64, ${LIST_CAPACITY}> l; Collection<uint64, ${QUEUE_CAPACITY}> q; BitArray<${BIT_COUNT}> wide;`,
);

test("a HashSet flag past its first window reports its slot", async () => {
    const flags = offsetOf(WIDE_FIELDS, "s") + SET.flagsOffset;
    const slot = 300_000;
    const window = diffWindow(
        flagByte(flags, slot),
        1,
        (bytes) => (bytes[0] = flagBits(slot, 1)),
        (bytes) => (bytes[0] = flagBits(slot, 2)),
    );

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([`s._occupationFlags[${slot}] 1 → 2`]);
});

// A list packs one bit per node rather than two, so it reads the run on a different stride.
test("a LinkedList occupied flag past its first window reports its node", async () => {
    const flags = offsetOf(WIDE_FIELDS, "l") + LIST.flagsOffset;
    const node = 200_000;
    const window = diffWindow(packedByte(flags, node, 1), 1, undefined, (bytes) => (bytes[0] = packedBits(node, 1, 1)));

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([`l._occupiedFlags[${node}] 0 → 1`]);
});

// A Collection's PoV flags were never diffed at any capacity, large or small.
test("a Collection PoV flag reports its index", async () => {
    const flags = offsetOf(WIDE_FIELDS, "q") + QUEUE.flagsOffset;
    const pov = 40_000;
    const window = diffWindow(flagByte(flags, pov), 1, undefined, (bytes) => (bytes[0] = flagBits(pov, 1)));

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([`q._povOccupationFlags[${pov}] 0 → 1`]);
});

test("a multi-megabyte BitArray reports the bit that flipped", async () => {
    const wide = offsetOf(WIDE_FIELDS, "wide");
    const bit = 3_000_000;
    const window = diffWindow(wide + (bit >> 3), 1, undefined, (bytes) => (bytes[0] = 1 << (bit & 7)));

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([`wide[${bit}] 0 → 1`]);
});

// A container's internal boundaries are nowhere near a window boundary once it is big, so a real diff
// hands over windows that straddle records into flags, or flags into the counters that follow them.
const MID_CAPACITY = 1 << 22;
const MID = hashMapGeometry(U64, U64, MID_CAPACITY);
const MID_FIELDS = fieldsOf("Mid", `HashMap<uint64, uint64, ${MID_CAPACITY}> m;`);
const MID_BASE = offsetOf(MID_FIELDS, "m");

test("a window crossing from the last record into the flags resolves both", async () => {
    const window = diffWindow(MID_BASE + MID.flagsOffset - 16, 32, undefined, (bytes) => {
        writeLe(bytes, 0, 5);
        bytes[16] = flagBits(0, 1);
    });

    expect(await rowsFor(MID_FIELDS, [window])).toEqual([`m.slot[${MID_CAPACITY - 1}].key 0 → 5`, "m._occupationFlags[0] 0 → 1"]);
});

// The counters sit immediately after the flags, and _markRemovalCounter had never been asserted at all.
test("a window crossing from the flags into the counters resolves all three", async () => {
    const window = diffWindow(MID_BASE + MID.populationOffset - 8, 24, undefined, (bytes) => {
        bytes[0] = flagBits(3, 1);
        writeLe(bytes, 8, 3);
        writeLe(bytes, 16, 9);
    });

    // The window opens eight bytes short of the counters, so its first slot is four per byte back.
    const firstSlot = (MID.flagsBytes - 8) * 4;

    expect(await rowsFor(MID_FIELDS, [window])).toEqual([`m._occupationFlags[${firstSlot + 3}] 0 → 1`, "m 0 → 3 entries", "m._markRemovalCounter 0 → 9"]);
});

test("a window opening exactly at the flags run reports from its first slot", async () => {
    const window = diffWindow(MID_BASE + MID.flagsOffset, 256, undefined, (bytes) => (bytes[0] = flagBits(1, 1)));

    expect(await rowsFor(MID_FIELDS, [window])).toEqual(["m._occupationFlags[1] 0 → 1"]);
});

// A journal coalesces consecutive dirty blocks, so an insert burst arrives as one region covering the
// records, the flags and the counters at once. Every window-sized test stops short of that shape.
const SPAN_CAPACITY = 4096;
const SPAN = hashMapGeometry(U64, U64, SPAN_CAPACITY);
const SPAN_FIELDS = fieldsOf("Span", `HashMap<uint64, uint64, ${SPAN_CAPACITY}> m;`);

test("one region covering a whole container resolves every zone in it", async () => {
    const slot = 3000;
    const record = slot * SPAN.recordStride;
    const window = diffWindow(offsetOf(SPAN_FIELDS, "m"), SPAN.populationOffset + 16, undefined, (bytes) => {
        writeLe(bytes, record, 11);
        writeLe(bytes, record + SPAN.valueOffset, 101);
        bytes[flagByte(SPAN.flagsOffset, slot)] = flagBits(slot, 1);
        writeLe(bytes, SPAN.populationOffset, 1);
    });

    expect(await rowsFor(SPAN_FIELDS, [window])).toEqual([
        `m.slot[${slot}].key 0 → 11`,
        "m[11] = 101 (new)",
        `m._occupationFlags[${slot}] 0 → 1`,
        "m 0 → 1 entries",
    ]);
});

// A core node reports minimal runs, so only the tail of a value can be dirty. Resolving that back to the
// start of the value is the same mistake the flags run used to make.
test("a window opening inside a value keeps the bytes it was given", async () => {
    const key = offsetOf(HUGE_FIELDS, "m") + 9822 * HUGE.recordStride;
    const window = diffWindow(key + 4, 4, undefined, (bytes) => writeLe(bytes, 0, 7, 4));

    expect(await rowsFor(HUGE_FIELDS, [window])).toEqual(["m.slot[9822].key+4 0x00000000 → 0x07000000"]);
});

test("a window ending inside a value keeps the bytes it was given", async () => {
    const key = offsetOf(HUGE_FIELDS, "m") + 9822 * HUGE.recordStride;
    const window = diffWindow(key, 2, undefined, (bytes) => writeLe(bytes, 0, 3195, 2));

    expect(await rowsFor(HUGE_FIELDS, [window])).toEqual(["m.slot[9822].key+0 0x0000 → 0x7b0c"]);
});

// An id key is 32 bytes, so a window boundary lands inside it far more often than inside a scalar one.
const ID_LAYOUT = { size: 32, align: 8 };
const OWNERS_CAPACITY = 1 << 20;
const OWNERS = hashMapGeometry(ID_LAYOUT, U64, OWNERS_CAPACITY);
const OWNERS_FIELDS = fieldsOf("Owners", `HashMap<id, uint64, ${OWNERS_CAPACITY}> owners;`);
const OWNERS_BASE = offsetOf(OWNERS_FIELDS, "owners");
const OWNER_SLOT = 500_000;
const OWNER_RECORD = OWNERS_BASE + OWNER_SLOT * OWNERS.recordStride;
const OWNER = "FXHSWSJBTCZHFAFXHSWSJBTCZHFAFXHSWSJBTCZHFAFXHSWSJBTCZHFAYKSC";

const ownerFlagWindow = () => {
    const flags = OWNERS_BASE + OWNERS.flagsOffset;
    return diffWindow(flagByte(flags, OWNER_SLOT), 1, undefined, (bytes) => (bytes[0] = flagBits(OWNER_SLOT, 1)));
};

test("an id key split across two adjacent windows is rejoined before it is read", async () => {
    const head = diffWindow(OWNER_RECORD, 16, undefined, (bytes) => bytes.fill(7));
    const tail = diffWindow(OWNER_RECORD + 16, 24, undefined, (bytes) => {
        bytes.fill(7, 0, 16);
        writeLe(bytes, 16, 9);
    });

    const rows = await rowsFor(OWNERS_FIELDS, [head, tail, ownerFlagWindow()]);

    expect(rows).toEqual([`owners.slot[${OWNER_SLOT}].key 0 → ${OWNER}`, `owners[${OWNER}] = 9 (new)`, `owners._occupationFlags[${OWNER_SLOT}] 0 → 1`]);
});

// Without the key in the window there is nothing better to name the row by than the bucket it hashed into.
test("a window carrying only the value keeps the row on its slot path", async () => {
    const value = diffWindow(OWNER_RECORD + OWNERS.valueOffset, 8, undefined, (bytes) => writeLe(bytes, 0, 9));

    expect(await rowsFor(OWNERS_FIELDS, [value, ownerFlagWindow()])).toEqual([
        `owners.slot[${OWNER_SLOT}].value 0 → 9`,
        `owners._occupationFlags[${OWNER_SLOT}] 0 → 1`,
    ]);
});

// Region hygiene. Nothing upstream emits these shapes today, so what the resolver does with them is
// recorded here rather than left to be rediscovered.
const NUMS_FIELDS = fieldsOf("Nums", `Array<uint64, ${1 << 23}> nums;`);
const NUMS_AT = 8_000_000;
const NUMS_INDEX = NUMS_AT / 8;
const numsWindow = (byteOffset: number, value: number) => diffWindow(byteOffset, 8, undefined, (bytes) => writeLe(bytes, 0, value));

test("regions handed over out of order resolve the same as sorted ones", async () => {
    const first = numsWindow(NUMS_AT, 11);
    const second = numsWindow(NUMS_AT + 8, 22);
    const third = numsWindow(NUMS_AT + 16, 33);
    const expected = [`nums[${NUMS_INDEX}] 0 → 11`, `nums[${NUMS_INDEX + 1}] 0 → 22`, `nums[${NUMS_INDEX + 2}] 0 → 33`];

    expect(await rowsFor(NUMS_FIELDS, [first, second, third])).toEqual(expected);
    expect(await rowsFor(NUMS_FIELDS, [third, first, second])).toEqual(expected);
});

// Regions are joined on exact adjacency, so an overlapping pair is walked twice and the shared value is
// reported twice with it. Pinned as it stands, not as it should be.
test("overlapping regions report the bytes they share twice", async () => {
    const left = diffWindow(NUMS_AT, 16, undefined, (bytes) => {
        writeLe(bytes, 0, 11);
        writeLe(bytes, 8, 22);
    });
    const right = diffWindow(NUMS_AT + 8, 16, undefined, (bytes) => {
        writeLe(bytes, 0, 22);
        writeLe(bytes, 8, 33);
    });

    expect(await rowsFor(NUMS_FIELDS, [left, right])).toEqual([
        `nums[${NUMS_INDEX}] 0 → 11`,
        `nums[${NUMS_INDEX + 1}] 0 → 22`,
        `nums[${NUMS_INDEX + 1}] 0 → 22`,
        `nums[${NUMS_INDEX + 2}] 0 → 33`,
    ]);
});

test("a region whose images differ in length is read to the shorter one", async () => {
    const after = new Uint8Array(24);
    writeLe(after, 0, 11);
    writeLe(after, 8, 22);
    writeLe(after, 16, 33);

    const lopsided = { off: NUMS_AT, before: hex(new Uint8Array(8)), after: hex(after) };

    expect(await rowsFor(NUMS_FIELDS, [lopsided])).toEqual([`nums[${NUMS_INDEX}] 0 → 11`]);
});

const payloadRowsFor = async (fields: StateField[], regions: DebugStateRegion[]) =>
    (await stateDiffLines(fields, regions)).filter((line) => !line.internal).map((line) => `${line.label} ${line.text}`);

const midRecord = (slot: number) => MID_BASE + slot * MID.recordStride;
const midFlag = (slot: number, from: number, to: number) =>
    diffWindow(
        flagByte(MID_BASE + MID.flagsOffset, slot),
        1,
        (bytes) => (bytes[0] = flagBits(slot, from)),
        (bytes) => (bytes[0] = flagBits(slot, to)),
    );

// One call can move a key: the old bucket is vacated and a new one takes it. Both halves name the same
// key, so grouping by bucket is the only thing keeping them from collapsing into each other.
test("a key that moves buckets in one call reports as a removal and an insert", async () => {
    const left = diffWindow(
        midRecord(100),
        16,
        (bytes) => {
            writeLe(bytes, 0, 11);
            writeLe(bytes, 8, 101);
        },
        (bytes) => bytes.fill(0),
    );
    const right = diffWindow(midRecord(700_000), 16, undefined, (bytes) => {
        writeLe(bytes, 0, 11);
        writeLe(bytes, 8, 202);
    });

    const rows = await payloadRowsFor(MID_FIELDS, [left, right, midFlag(100, 1, 2), midFlag(700_000, 0, 1)]);

    expect(rows).toEqual(["m[11] 101 → (removed)", "m[11] = 202 (new)"]);
});

// A HashSet slot is the key alone, so its removal is the one shape where the key row has to carry the
// entry line by itself. Nothing exercised it before.
const SET_BASE = offsetOf(WIDE_FIELDS, "s");
const SET_SLOT = 300_000;
const setFlag = (from: number, to: number) =>
    diffWindow(
        flagByte(SET_BASE + SET.flagsOffset, SET_SLOT),
        1,
        (bytes) => (bytes[0] = flagBits(SET_SLOT, from)),
        (bytes) => (bytes[0] = flagBits(SET_SLOT, to)),
    );

test("a HashSet removal is named by the key the slot held", async () => {
    const record = diffWindow(
        SET_BASE + SET_SLOT * SET.recordStride,
        8,
        (bytes) => writeLe(bytes, 0, 77),
        (bytes) => bytes.fill(0),
    );
    const population = diffWindow(
        SET_BASE + SET.populationOffset,
        8,
        (bytes) => writeLe(bytes, 0, 1),
        (bytes) => writeLe(bytes, 0, 0),
    );

    expect(await payloadRowsFor(WIDE_FIELDS, [record, setFlag(1, 2), population])).toEqual(["s[77] (removed)", "s 1 → 0 entries"]);
});

test("a HashSet slot reused from a tombstone reads as a new entry", async () => {
    const record = diffWindow(SET_BASE + SET_SLOT * SET.recordStride, 8, undefined, (bytes) => writeLe(bytes, 0, 77));
    const population = diffWindow(SET_BASE + SET.populationOffset, 8, undefined, (bytes) => writeLe(bytes, 0, 1));

    expect(await payloadRowsFor(WIDE_FIELDS, [record, setFlag(2, 1), population])).toEqual(["s[77] (new)", "s 0 → 1 entries"]);
});

// Sixty-four inserts scattered over a 545 MB map, each arriving as its own record window and its own flag
// window a long way off. Every entry has to find its own key and its own flag among 128 regions.
test("many inserts across scattered windows each keep their own key", async () => {
    const slots = [0, 9822, HUGE_CAPACITY - 1, ...Array.from({ length: 61 }, (_, index) => 500_000 + index * 100_003)];
    const base = offsetOf(HUGE_FIELDS, "m");
    const regions = slots.flatMap((slot, index) => [
        diffWindow(base + slot * HUGE.recordStride, 16, undefined, (bytes) => {
            writeLe(bytes, 0, 1000 + index);
            writeLe(bytes, 8, 2000 + index);
        }),
        diffWindow(flagByte(HUGE_FLAGS, slot), 1, undefined, (bytes) => (bytes[0] = flagBits(slot, 1))),
    ]);

    const rows = await payloadRowsFor(HUGE_FIELDS, regions);
    const expected = [...slots.keys()].map((index) => `m[${1000 + index}] = ${2000 + index} (new)`);

    expect(rows.slice().sort()).toEqual(expected.slice().sort());
});

// A Collection keeps two record tables, and neither had ever been resolved by a diff.
const QUEUE_BASE = offsetOf(WIDE_FIELDS, "q");
const QUEUE_INDEX = 40_000;
const POV_OWNER = "RNOLNPLPPIDHCARNOLNPLPPIDHCARNOLNPLPPIDHCARNOLNPLPPIDHCAJRAI";

test("a Collection PoV record resolves to its members", async () => {
    const window = diffWindow(QUEUE_BASE + QUEUE_INDEX * QUEUE.povStride, QUEUE.povStride, undefined, (bytes) => {
        bytes.fill(3, 0, 32);
        writeLe(bytes, QUEUE.povPopulationOffset, 2);
        writeLe(bytes, QUEUE.povHeadOffset, 5);
        writeLe(bytes, QUEUE.povTailOffset, 6);
        writeLe(bytes, QUEUE.povBstRootOffset, 1);
    });

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([
        `q.pov[${QUEUE_INDEX}] 0 → ${POV_OWNER}`,
        `q.pov[${QUEUE_INDEX}].population 0 → 2`,
        `q.pov[${QUEUE_INDEX}].headIndex 0 → 5`,
        `q.pov[${QUEUE_INDEX}].tailIndex 0 → 6`,
        `q.pov[${QUEUE_INDEX}].bstRootIndex 0 → 1`,
    ]);
});

test("a Collection element resolves to its value, priority and links", async () => {
    const element = QUEUE_BASE + QUEUE.elementsOffset + QUEUE_INDEX * QUEUE.elementStride;
    const window = diffWindow(element, QUEUE.elementStride, undefined, (bytes) => {
        writeLe(bytes, QUEUE.elementValueOffset, 42);
        writeLe(bytes, QUEUE.elementPriorityOffset, 7);
        writeLe(bytes, QUEUE.elementPovIndexOffset, 3);
    });

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([`q[${QUEUE_INDEX}] 0 → 42`, `q[${QUEUE_INDEX}].priority 0 → 7`, `q[${QUEUE_INDEX}].povIndex 0 → 3`]);
});

// prevIndex and the free-list head are what a list write actually touches, and neither was asserted.
const LIST_BASE = offsetOf(WIDE_FIELDS, "l");
const LIST_NODE = 200_000;

test("a LinkedList node resolves both of its links", async () => {
    const window = diffWindow(LIST_BASE + LIST_NODE * LIST.nodeStride, LIST.nodeStride, undefined, (bytes) => {
        writeLe(bytes, 0, 66);
        writeLe(bytes, LIST.nextOffset, -1);
        writeLe(bytes, LIST.prevOffset, 5);
    });

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([`l[${LIST_NODE}] 0 → 66`, `l[${LIST_NODE}].nextIndex 0 → -1`, `l[${LIST_NODE}].prevIndex 0 → 5`]);
});

test("a LinkedList bookkeeping tail resolves every word it holds", async () => {
    const window = diffWindow(LIST_BASE + LIST.headOffset, 40, undefined, (bytes) => {
        writeLe(bytes, 0, 3);
        writeLe(bytes, LIST.tailOffset - LIST.headOffset, 4);
        writeLe(bytes, LIST.freeHeadOffset - LIST.headOffset, 9);
        writeLe(bytes, LIST.nextUnusedOffset - LIST.headOffset, 2);
        writeLe(bytes, LIST.populationOffset - LIST.headOffset, 7);
    });

    expect(await rowsFor(WIDE_FIELDS, [window])).toEqual([
        "l._headIndex 0 → 3",
        "l._tailIndex 0 → 4",
        "l._freeHeadIndex 0 → 9",
        "l._nextUnusedIndex 0 → 2",
        "l 0 → 7 entries",
    ]);
});

// A container inside a container: the value of a map entry is itself a packed bit run.
const NESTED_CAPACITY = 1 << 16;
const NESTED = hashMapGeometry(U64, U64, NESTED_CAPACITY);
const NESTED_FIELDS = fieldsOf("Nested", `HashMap<uint64, BitArray<64>, ${NESTED_CAPACITY}> nested;`);

test("a BitArray held as a map value reports the bit that flipped", async () => {
    const slot = 40_000;
    const window = diffWindow(offsetOf(NESTED_FIELDS, "nested") + slot * NESTED.recordStride, 16, undefined, (bytes) => {
        writeLe(bytes, 0, 11);
        bytes[NESTED.valueOffset] = 1 << 3;
    });

    expect(await rowsFor(NESTED_FIELDS, [window])).toEqual([`nested.slot[${slot}].key 0 → 11`, `nested.slot[${slot}].value[3] 0 → 1`]);
});

// A wide write reports one row per changed byte and nothing caps that. 64 KiB is the affordable slice of
// a ceiling worth writing down: about 1.05M rows and 1.7s per dirty MiB, against a journal that admits
// 63 MiB of dirty state per dispatch.
test("a fully dirty region reports one row per changed byte", async () => {
    const BLOB_FIELDS = fieldsOf("Blob", `Array<uint8, ${1 << 28}> data;`);
    const length = 64 * 1024;
    const window = diffWindow(0, length, undefined, (bytes) => bytes.fill(1));

    expect(await stateDiffLines(BLOB_FIELDS, [window])).toHaveLength(length);
});
