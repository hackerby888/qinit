// Windows the engine cannot aim on purpose: one opening inside a struct element, one covering a struct holding a container, entries leaving only a flag.
import { expect, test } from "bun:test";
import { collectionGeometry, hashMapGeometry, hashSetGeometry, linkedListGeometry } from "@qinit/proto/qpi-layout";
import { pastCapacityWarnings, stateDiffLines, type StateDiffLine } from "../../src/trace/state-diff";
import { diffWindow, fieldsOf, offsetOf, writeLe } from "./diff-window";
import type { StateField } from "../../src/trace/state-format";
import { bytesToIdentity, type DebugStateRegion } from "@qinit/core";

const U64 = { size: 8, align: 8 };

const flat = (line: StateDiffLine) => `${line.label} ${line.text}`;
const shown = async (fields: StateField[], regions: DebugStateRegion[]) => (await stateDiffLines(fields, regions)).filter((line) => !line.internal).map(flat);
const hidden = async (fields: StateField[], regions: DebugStateRegion[]) => (await stateDiffLines(fields, regions)).filter((line) => line.internal).map(flat);

// Two-bit occupation flags, one flag word per 32 slots, written by slot.
const setFlag = (bytes: Uint8Array, flagsOff: number, slot: number, value: number) => {
    bytes[flagsOff + (slot >> 2)] |= value << ((slot & 3) * 2);
};

const ORDER = "struct Order { id entity; sint64 amount; uint32 flags; };";
const ORDERS = fieldsOf("Orders", "Collection<Order, 8> orders;", ORDER);
const ORDERS_GEOMETRY = collectionGeometry({ size: 48, align: 8 }, 8);

test("a window opening inside a struct element ahead of the changed member reports that member once", async () => {
    // Order's last four bytes are padding. Opening 24 bytes into element 1 used to make the padding step resolve to the whole struct and repeat the change.
    const element = offsetOf(ORDERS, "orders") + ORDERS_GEOMETRY.elementsOffset + ORDERS_GEOMETRY.elementStride;
    const window = diffWindow(element + 24, ORDERS_GEOMETRY.elementStride - 24, undefined, (bytes) => {
        writeLe(bytes, 8, -2n);
        writeLe(bytes, 24, -200n);
    });

    expect(await shown(ORDERS, [window])).toEqual(["orders[1].amount 0 → -2", "orders[1].priority 0 → -200"]);
});

const MAP = hashMapGeometry(U64, U64, 4);
const DEEPER = fieldsOf("Deeper", "Deeper deeper;", "struct Deeper { uint64 value; HashMap<uint64, uint64, 4> map; };");

// One live entry: key 5 → 6 in slot 2 of a HashMap<uint64, uint64, 4> that starts at `at`.
function putEntry(bytes: Uint8Array, at: number, slot: number, key: bigint, value: bigint) {
    writeLe(bytes, at + slot * MAP.elementStride, key);
    writeLe(bytes, at + slot * MAP.elementStride + MAP.elementValueOffset, value);
    setFlag(bytes, at + MAP.flagsOffset, slot, 1);
    writeLe(bytes, at + MAP.populationOffset, 1n);
}

test("a struct holding a container never collapses to one row, even when a window covers all of it", async () => {
    const field = DEEPER.find((candidate) => candidate.name === "deeper")!;
    const window = diffWindow(field.off, field.size, undefined, (bytes) => {
        writeLe(bytes, 0, 7n);
        putEntry(bytes, 8, 2, 5n, 6n);
    });

    expect(await shown(DEEPER, [window])).toEqual(["deeper.value 0 → 7", "deeper.map[5] = 6 (new)", "deeper.map 0 → 1 entries"]);
    expect(await hidden(DEEPER, [window])).toEqual(["deeper.map.slot[2].key 0 → 5", "deeper.map._occupationFlags[2] 0 → 1"]);
});

test("a struct made only of containers reports each container's entries under its path", async () => {
    const SET = hashSetGeometry(U64, 4);
    const fields = fieldsOf("Only", "Only only;", "struct Only { HashMap<uint64, uint64, 4> a; HashSet<uint64, 4> b; };");
    const field = fields.find((candidate) => candidate.name === "only")!;
    const window = diffWindow(field.off, field.size, undefined, (bytes) => {
        putEntry(bytes, 0, 1, 1n, 10n);
        writeLe(bytes, MAP.size + 2 * SET.keyStride, 2n);
        setFlag(bytes, MAP.size + SET.flagsOffset, 2, 1);
        writeLe(bytes, MAP.size + SET.populationOffset, 1n);
    });

    expect(await shown(fields, [window])).toEqual(["only.a[1] = 10 (new)", "only.a 0 → 1 entries", "only.b[2] (new)", "only.b 0 → 1 entries"]);
});

test("an element two arrays down and a bit two arrays down are named by both indexes", async () => {
    const fields = fieldsOf("Grid", "Array<Array<uint16, 4>, 2> grid; Array<BitArray<64>, 2> bitGrid;");
    const window = diffWindow(0, 32, undefined, (bytes) => {
        writeLe(bytes, 8 + 2 * 2, 9n, 2);
        bytes[16 + 8 + 7] |= 0x80;
    });

    expect(await shown(fields, [window])).toEqual(["grid[1][2] 0 → 9", "bitGrid[1][63] 0 → 1"]);
});

test("a struct two levels down names its field, and a plain struct covered whole is one row", async () => {
    const fields = fieldsOf("Nested", "Outer outer;", "struct Inner { uint64 x; uint64 y; }; struct Outer { uint64 a; Inner inner; };");
    const y = diffWindow(16, 8, undefined, (bytes) => writeLe(bytes, 0, 5n));
    const whole = diffWindow(0, 24, undefined, (bytes) => writeLe(bytes, 16, 5n));

    expect(await shown(fields, [y])).toEqual(["outer.inner.y 0 → 5"]);
    expect(await shown(fields, [whole])).toEqual(["outer 0 → {a: 0, inner: {x: 0, y: 5}}"]);
});

test("a negative key and a nested-struct key label their entries as the contract wrote them", async () => {
    const KEY = hashMapGeometry({ size: 24, align: 8 }, U64, 4);
    const fields = fieldsOf(
        "Keys",
        "HashMap<sint64, uint64, 4> signedKey; HashMap<Key, uint64, 4> byKey;",
        "struct Sub { uint64 a; uint64 b; }; struct Key { Sub sub; uint32 asset; };",
    );
    const byKey = offsetOf(fields, "byKey");
    const window = diffWindow(0, byKey + KEY.size, undefined, (bytes) => {
        putEntry(bytes, 0, 0, -5n, 9n);
        writeLe(bytes, byKey + KEY.elementStride, 1n);
        writeLe(bytes, byKey + KEY.elementStride + 8, 2n);
        writeLe(bytes, byKey + KEY.elementStride + 16, 3n, 4);
        writeLe(bytes, byKey + KEY.elementStride + KEY.elementValueOffset, 4n);
        setFlag(bytes, byKey + KEY.flagsOffset, 1, 1);
        writeLe(bytes, byKey + KEY.populationOffset, 1n);
    });

    expect(await shown(fields, [window])).toEqual([
        "signedKey[-5] = 9 (new)",
        "signedKey 0 → 1 entries",
        "byKey[{sub: {a: 1, b: 2}, asset: 3}] = 4 (new)",
        "byKey 0 → 1 entries",
    ]);
});

const PLAIN = fieldsOf("Plain", "HashMap<uint64, uint64, 4> map;");

test("an entry whose key and value are both zero is named by its flag when the record is in the window", async () => {
    const arrived = diffWindow(0, MAP.size, undefined, (bytes) => {
        setFlag(bytes, MAP.flagsOffset, 3, 1);
        writeLe(bytes, MAP.populationOffset, 1n);
    });
    const left = diffWindow(
        0,
        MAP.size,
        (bytes) => {
            setFlag(bytes, MAP.flagsOffset, 3, 1);
            writeLe(bytes, MAP.populationOffset, 1n);
        },
        (bytes) => {
            bytes[MAP.flagsOffset] = 0b10 << 6;
            writeLe(bytes, MAP.populationOffset, 0n);
            writeLe(bytes, MAP.populationOffset + 8, 1n);
        },
    );

    expect(await shown(PLAIN, [arrived])).toEqual(["map[0] (new)", "map 0 → 1 entries"]);
    expect(await shown(PLAIN, [left])).toEqual(["map[0] (removed)", "map 1 → 0 entries"]);
});

test("the same flag with its record outside the window stays bookkeeping", async () => {
    const window = diffWindow(MAP.flagsOffset, 16, undefined, (bytes) => {
        setFlag(bytes, 0, 3, 1);
        writeLe(bytes, 8, 1n);
    });

    expect(await shown(PLAIN, [window])).toEqual(["map 0 → 1 entries"]);
    expect(await hidden(PLAIN, [window])).toEqual(["map._occupationFlags[3] 0 → 1"]);
});

test("a BitArray held by a keyed record reads by the key, arriving and changing", async () => {
    const BITS = hashMapGeometry(U64, U64, 4);
    const fields = fieldsOf("Bits", "HashMap<uint64, BitArray<64>, 4> bitValues;");
    const record = BITS.elementStride;
    const arrived = diffWindow(0, BITS.size, undefined, (bytes) => {
        writeLe(bytes, record, 1n);
        bytes[record + BITS.elementValueOffset] = 1 << 3;
        bytes[record + BITS.elementValueOffset + 7] = 0x80;
        setFlag(bytes, BITS.flagsOffset, 1, 1);
        writeLe(bytes, BITS.populationOffset, 1n);
    });
    const changed = diffWindow(
        0,
        BITS.size,
        (bytes) => {
            writeLe(bytes, record, 1n);
            bytes[record + BITS.elementValueOffset] = 1 << 3;
            setFlag(bytes, BITS.flagsOffset, 1, 1);
            writeLe(bytes, BITS.populationOffset, 1n);
        },
        (bytes) => {
            bytes[record + BITS.elementValueOffset + 7] = 0x80;
        },
    );

    expect(await shown(fields, [arrived])).toEqual(["bitValues[1][3] = 1 (new)", "bitValues[1][63] = 1 (new)", "bitValues 0 → 1 entries"]);
    expect(await hidden(fields, [arrived])).toEqual(["bitValues.slot[1].key 0 → 1", "bitValues._occupationFlags[1] 0 → 1"]);
    expect(await shown(fields, [changed])).toEqual(["bitValues[1][63] 0 → 1"]);
});

// core's set(i) masks only the word index, so a BitArray under 64 bits has a writable tail; a flip there moved bytes and must not go without a row.
test("a bit flipped past a small BitArray's capacity is reported and marked, top level and as a keyed value", async () => {
    const small = fieldsOf("Small", "BitArray<2> bits; uint64 after;");
    // bit 2 is the first index past a BitArray<2>, the off-by-one a `<=` loop writes
    const flip = diffWindow(0, 16, undefined, (bytes) => {
        bytes[0] = (1 << 1) | (1 << 2) | (1 << 5);
        bytes[7] = 0x80;
    });
    expect(await shown(small, [flip])).toEqual([
        "bits[1] 0 → 1",
        "bits[2] 0 → 1 (past capacity 2)",
        "bits[5] 0 → 1 (past capacity 2)",
        "bits[63] 0 → 1 (past capacity 2)",
    ]);
    expect((await stateDiffLines(small, [flip])).map((line) => line.pastCapacity)).toEqual([undefined, 2, 2, 2]);

    // a BitArray<16> value is one uint64 word, so the record layout is MAP's
    const keyed = fieldsOf("KeyedSmall", "HashMap<uint64, BitArray<16>, 4> m;");
    const record = MAP.elementStride;
    const update = diffWindow(
        0,
        MAP.size,
        (bytes) => {
            writeLe(bytes, record, 7n);
            setFlag(bytes, MAP.flagsOffset, 1, 1);
            writeLe(bytes, MAP.populationOffset, 1n);
        },
        (bytes) => {
            bytes[record + MAP.elementValueOffset + 2] = 1 << 4;
        },
    );
    expect(await shown(keyed, [update])).toEqual(["m[7][20] 0 → 1 (past capacity 16)"]);
    expect(pastCapacityWarnings([...(await stateDiffLines(small, [flip])), ...(await stateDiffLines(keyed, [update]))])).toEqual([
        "⚠ bits: bits 2, 5, 63 written past BitArray<2> capacity — set() got an index ≥ 2, which core doesn't reject and get(i) reads back; check the index",
        "⚠ m[7]: bit 20 written past BitArray<16> capacity — set() got an index ≥ 16, which core doesn't reject and get(i) reads back; check the index",
    ]);

    // 64 bits fill the word, so every index is a real one and nothing is marked
    const full = fieldsOf("Full", "BitArray<64> bits;");
    expect(await shown(full, [diffWindow(0, 8, undefined, (bytes) => (bytes[7] = 0x80))])).toEqual(["bits[63] 0 → 1"]);
});

test("no regions is no rows", async () => {
    expect(await stateDiffLines(ORDERS, [])).toEqual([]);
});

test("a Collection element's id and its bookkeeping share one record without bleeding into each other", async () => {
    const element = offsetOf(ORDERS, "orders") + ORDERS_GEOMETRY.elementsOffset;
    const window = diffWindow(element, ORDERS_GEOMETRY.elementStride, undefined, (bytes) => {
        bytes[0] = 3;
        writeLe(bytes, 32, 7n);
        writeLe(bytes, 48, -100n);
        writeLe(bytes, 64, -1n);
    });

    const entity = await bytesToIdentity(new Uint8Array([3, ...new Array(31).fill(0)]));

    expect(await shown(ORDERS, [window])).toEqual([`orders[0] 0 → {entity: "${entity}", amount: 7, flags: 0}`, "orders[0].priority 0 → -100"]);
    expect(await hidden(ORDERS, [window])).toEqual(["orders[0].bstParentIndex 0 → -1"]);
});

const REC = "struct Rec { uint32 a; uint64 b; uint32 c; uint64 d; };";
const PADDED = fieldsOf("Padded", "Rec rec; uint64 tail;", REC);
const REC_ARRAY = fieldsOf("PaddedArray", "Array<Rec, 2> recs;", REC);

test("a window opening inside a struct's interior padding still reports every later field", async () => {
    // Rec pads 4..8 and 20..24. Opening in the first pad used to size the padding step to the struct's end, so b and d were walked over without a row.
    const window = diffWindow(offsetOf(PADDED, "rec") + 4, 28, undefined, (bytes) => {
        writeLe(bytes, 4, 42n);
        writeLe(bytes, 20, 44n);
    });

    expect(await shown(PADDED, [window])).toEqual(["rec.b 0 → 42", "rec.d 0 → 44"]);
});

test("interior padding inside an array element resolves to the element's next field", async () => {
    const window = diffWindow(offsetOf(REC_ARRAY, "recs") + 32 + 4, 28, undefined, (bytes) => {
        writeLe(bytes, 4, 42n);
        writeLe(bytes, 20, 44n);
    });

    expect(await shown(REC_ARRAY, [window])).toEqual(["recs[1].b 0 → 42", "recs[1].d 0 → 44"]);
});

test("a window covering the padded struct exactly still reports it as one row", async () => {
    const window = diffWindow(offsetOf(PADDED, "rec"), 32, undefined, (bytes) => {
        writeLe(bytes, 8, 42n);
        writeLe(bytes, 24, 44n);
    });

    expect(await shown(PADDED, [window])).toEqual(["rec 0 → {a: 0, b: 42, c: 0, d: 44}"]);
});

// S7 step 1: a key and the row naming it can land in different, non-adjacent windows.
const BIG_VALUE = "struct BigValue { uint64 lead; Array<uint64, 32> pad; uint64 last; };";
const BIG_MAP = fieldsOf("BigMap", "HashMap<uint64, BigValue, 2> m; uint64 tail;", BIG_VALUE);
const BIG_MAP_GEOMETRY = hashMapGeometry(U64, { size: 272, align: 8 }, 2);
const BIG_MAP_OFF = offsetOf(BIG_MAP, "m");
const LAST_IN_VALUE = 264;

test("a record is named by a key that changed in another, non-adjacent window", async () => {
    const key = diffWindow(BIG_MAP_OFF, 8, undefined, (bytes) => writeLe(bytes, 0, 11));
    const last = diffWindow(BIG_MAP_OFF + BIG_MAP_GEOMETRY.elementValueOffset + LAST_IN_VALUE, 8, undefined, (bytes) => writeLe(bytes, 0, 99));

    expect(await shown(BIG_MAP, [key, last])).toEqual(["m[11].last 0 → 99"]);
});

test("a leaving record is named by the key only its own window still holds, in the before image", async () => {
    // The key survives only in that window's `before`; the row and the flag are in other windows.
    const key = diffWindow(BIG_MAP_OFF, 8, (bytes) => writeLe(bytes, 0, 11), (bytes) => writeLe(bytes, 0, 0));
    const last = diffWindow(BIG_MAP_OFF + BIG_MAP_GEOMETRY.elementValueOffset + LAST_IN_VALUE, 8, (bytes) => writeLe(bytes, 0, 99), (bytes) => writeLe(bytes, 0, 0));
    // `setFlag` ORs and the after image copies before, so write the removal bit flat.
    const flags = diffWindow(BIG_MAP_OFF + BIG_MAP_GEOMETRY.flagsOffset, 8, (bytes) => setFlag(bytes, 0, 0, 1), (bytes) => (bytes[0] = 2));

    expect(await shown(BIG_MAP, [key, last, flags])).toEqual(["m[11].last 99 → (removed)"]);
    // The flag row carries the same key — the only name for a record in another window.
    expect(await hidden(BIG_MAP, [key, last, flags])).toContain("m._occupationFlags[0] 1 → 2");
});

// S7 step 2: an update leaves the key in no window, so naming the entry means reading it back.
const KEY_AT = BIG_MAP_OFF;
const LAST_AT = BIG_MAP_OFF + BIG_MAP_GEOMETRY.elementValueOffset + LAST_IN_VALUE;
const keyReaderOf = (value: number | null) => {
    const calls: [number, number][] = [];
    const read = async (off: number, size: number) => {
        calls.push([off, size]);
        if (value === null) {
            return undefined;
        }
        const bytes = new Uint8Array(size);
        writeLe(bytes, 0, value);
        return bytes;
    };
    return { read, calls };
};

test("a value update names its entry from a key read back from the node", async () => {
    const update = diffWindow(LAST_AT, 8, (bytes) => writeLe(bytes, 0, 99), (bytes) => writeLe(bytes, 0, 42));
    const reader = keyReaderOf(11);

    expect((await stateDiffLines(BIG_MAP, [update], reader.read)).map(flat)).toEqual(["m[11].last 99 → 42"]);
    expect(reader.calls).toEqual([[KEY_AT, 8]]);
});

test("a key the node cannot answer for leaves the row on its bucket, and says so", async () => {
    const update = diffWindow(LAST_AT, 8, (bytes) => writeLe(bytes, 0, 99), (bytes) => writeLe(bytes, 0, 42));

    for (const reader of [keyReaderOf(null).read, undefined]) {
        const lines = await stateDiffLines(BIG_MAP, [update], reader);
        expect(lines.map(flat)).toEqual(["m.slot[0].value.last 99 → 42"]);
        expect(lines[0].keyUnresolved).toBe(true);
    }
});

test("a leaving entry is never named by a key read back after it left", async () => {
    // The slot now reads zeros; naming the row `m[0]` would be a lie, so fall back to the bucket.
    const last = diffWindow(LAST_AT, 8, (bytes) => writeLe(bytes, 0, 99), (bytes) => writeLe(bytes, 0, 0));
    const flags = diffWindow(BIG_MAP_OFF + BIG_MAP_GEOMETRY.flagsOffset, 8, (bytes) => setFlag(bytes, 0, 0, 1), (bytes) => (bytes[0] = 2));
    const zeros = keyReaderOf(0);

    const lines = await stateDiffLines(BIG_MAP, [last, flags], zeros.read);
    // Unnamed: raw text, not the entry wording, and not `m[0]`.
    expect(lines.map(flat).filter((line) => !line.startsWith("m._"))).toEqual(["m.slot[0].value.last 99 → 0"]);
    expect(lines.map(flat).some((line) => line.startsWith("m[0]"))).toBe(false);
});

test("two rows of one record cost a single key read", async () => {
    const both = diffWindow(BIG_MAP_OFF + BIG_MAP_GEOMETRY.elementValueOffset, 272, undefined, (bytes) => {
        writeLe(bytes, 0, 7); // lead
        writeLe(bytes, LAST_IN_VALUE, 8); // last
    });
    const reader = keyReaderOf(11);

    expect((await stateDiffLines(BIG_MAP, [both], reader.read)).map(flat)).toEqual(["m[11].lead 0 → 7", "m[11].last 0 → 8"]);
    expect(reader.calls).toEqual([[KEY_AT, 8]]);
});

// Keyed inside keyed: an entry is named by every key on the way down, and the inner container's own words read through the outer key.
const ID = { size: 32, align: 8 };
const INNER_SET = hashSetGeometry(ID, 4);
const MAPSETS = hashMapGeometry(ID, { size: INNER_SET.size, align: INNER_SET.align }, 2);
const INNER = hashMapGeometry(U64, U64, 4);
const M = hashMapGeometry(U64, { size: INNER.size, align: INNER.align }, 4);
const S = hashSetGeometry(U64, 4);
const P = hashMapGeometry(U64, { size: S.size + 8, align: 8 }, 4);
const BITS16 = hashMapGeometry(U64, U64, 4);
const MB = hashMapGeometry(U64, { size: BITS16.size, align: BITS16.align }, 4);
const NESTED = fieldsOf(
    "NestedKeyed",
    "HashMap<id, HashSet<id, 4>, 2> mapsets; HashMap<uint64, HashMap<uint64, uint64, 4>, 4> m; HashMap<uint64, Pair, 4> p; HashMap<uint64, HashMap<uint64, BitArray<16>, 4>, 4> mb;",
    "struct Pair { HashSet<uint64, 4> s; uint64 x; };",
);
const MAPSETS_AT = offsetOf(NESTED, "mapsets");
const M_AT = offsetOf(NESTED, "m");
const P_AT = offsetOf(NESTED, "p");
const MB_AT = offsetOf(NESTED, "mb");

// two-bit flag written flat, so a transition away from 1 does not OR into 3
const putFlag = (bytes: Uint8Array, flagsOff: number, slot: number, value: number) => {
    const shift = (slot & 3) * 2;
    bytes[flagsOff + (slot >> 2)] = (bytes[flagsOff + (slot >> 2)] & ~(3 << shift)) | (value << shift);
};

// m: outer key 5 in slot 1 holding inner 6 -> 60 in inner slot 2
const M_OUTER = M.elementStride;
const M_INNER = M_OUTER + M.elementValueOffset;
const innerKeyAt = (slot: number) => M_INNER + slot * INNER.elementStride;
const innerValueAt = (slot: number) => innerKeyAt(slot) + INNER.elementValueOffset;
function liveOuter(bytes: Uint8Array) {
    writeLe(bytes, M_OUTER, 5n);
    putFlag(bytes, M.flagsOffset, 1, 1);
    writeLe(bytes, M.populationOffset, 1n);
    writeLe(bytes, innerKeyAt(2), 6n);
    writeLe(bytes, innerValueAt(2), 60n);
    putFlag(bytes, M_INNER + INNER.flagsOffset, 2, 1);
    writeLe(bytes, M_INNER + INNER.populationOffset, 1n);
}
function innerInsert(bytes: Uint8Array) {
    writeLe(bytes, innerKeyAt(3), 7n);
    writeLe(bytes, innerValueAt(3), 9n);
    putFlag(bytes, M_INNER + INNER.flagsOffset, 3, 1);
    writeLe(bytes, M_INNER + INNER.populationOffset, 2n);
}
const mWindow = (seed?: (bytes: Uint8Array) => void, write?: (bytes: Uint8Array) => void) => diffWindow(M_AT, M.size, seed, write);

test("an inner entry arriving with its outer is named by both keys, and the inner counter by the outer", async () => {
    const outer = MAPSETS.elementStride;
    const inner = outer + MAPSETS.elementValueOffset;
    const window = diffWindow(MAPSETS_AT, MAPSETS.size, undefined, (bytes) => {
        bytes.fill(0x50, outer, outer + 32);
        bytes.fill(0x49, inner, inner + 32);
        putFlag(bytes, inner + INNER_SET.flagsOffset, 0, 1);
        writeLe(bytes, inner + INNER_SET.populationOffset, 1n);
        putFlag(bytes, MAPSETS.flagsOffset, 1, 1);
        writeLe(bytes, MAPSETS.populationOffset, 1n);
    });
    const outerKey = await bytesToIdentity(new Uint8Array(32).fill(0x50));
    const innerKey = await bytesToIdentity(new Uint8Array(32).fill(0x49));

    expect(await shown(NESTED, [window])).toEqual([`mapsets[${outerKey}][${innerKey}] (new)`, `mapsets[${outerKey}] 0 → 1 entries`, "mapsets 0 → 1 entries"]);
    expect(await hidden(NESTED, [window])).toEqual([
        `mapsets.slot[1].key 0 → ${outerKey}`,
        "mapsets.slot[1].value._occupationFlags[0] 0 → 1",
        "mapsets._occupationFlags[1] 0 → 1",
    ]);
    const lines = await stateDiffLines(NESTED, [window]);
    expect(lines.map((line) => line.detail)).toEqual([
        "mapsets._elements[1].key",
        "mapsets._elements[1].value._keys[0]",
        "mapsets._elements[1].value._occupationFlags[0]",
        "mapsets._elements[1].value._population",
        "mapsets._occupationFlags[1]",
        "mapsets._population",
    ]);
});

test("an inner insert into a live outer entry", async () => {
    const window = mWindow(liveOuter, innerInsert);

    expect(await shown(NESTED, [window])).toEqual(["m[5][7] = 9 (new)", "m[5] 1 → 2 entries"]);
    expect(await hidden(NESTED, [window])).toEqual(["m.slot[1].value.slot[3].key 0 → 7", "m.slot[1].value._occupationFlags[3] 0 → 1"]);
});

test("an inner update is one row named by both keys", async () => {
    const window = mWindow(
        (bytes) => {
            liveOuter(bytes);
            innerInsert(bytes);
        },
        (bytes) => writeLe(bytes, innerValueAt(3), 10n),
    );

    expect((await stateDiffLines(NESTED, [window])).map(flat)).toEqual(["m[5][7] 9 → 10"]);
});

test("an inner removal reads as removed under both keys", async () => {
    const window = mWindow(
        (bytes) => {
            liveOuter(bytes);
            innerInsert(bytes);
        },
        (bytes) => {
            writeLe(bytes, innerKeyAt(3), 0n);
            writeLe(bytes, innerValueAt(3), 0n);
            putFlag(bytes, M_INNER + INNER.flagsOffset, 3, 2);
            writeLe(bytes, M_INNER + INNER.populationOffset, 1n);
            writeLe(bytes, M_INNER + INNER.markRemovalCounterOffset, 1n);
        },
    );

    expect(await shown(NESTED, [window])).toEqual(["m[5][7] 9 → (removed)", "m[5] 2 → 1 entries"]);
    expect(await hidden(NESTED, [window])).toEqual([
        "m.slot[1].value.slot[3].key 7 → 0",
        "m.slot[1].value._occupationFlags[3] 1 → 2",
        "m[5]._markRemovalCounter 0 → 1",
    ]);
});

// core zeroes the whole outer element, so the inner flag drops to 0 rather than 2: the inner entry reads vacated, named from the before images at both levels.
test("removing the outer entry vacates the inner one under both before-image keys", async () => {
    const window = mWindow(liveOuter, (bytes) => {
        bytes.fill(0, M_OUTER, M_OUTER + M.elementStride);
        putFlag(bytes, M.flagsOffset, 1, 2);
        writeLe(bytes, M.populationOffset, 0n);
        writeLe(bytes, M.markRemovalCounterOffset, 1n);
    });

    expect(await shown(NESTED, [window])).toEqual(["m[5][6] 60 → 0", "m[5] 1 → 0 entries", "m 1 → 0 entries"]);
    expect(await hidden(NESTED, [window])).toEqual([
        "m.slot[1].key 5 → 0",
        "m.slot[1].value.slot[2].key 6 → 0",
        "m.slot[1].value._occupationFlags[2] 1 → 0",
        "m._occupationFlags[1] 1 → 2",
        "m._markRemovalCounter 0 → 1",
    ]);
});

test("a set inside a struct value keeps the struct member between the keys", async () => {
    const outer = 3 * P.elementStride;
    const set = outer + P.elementValueOffset;
    const window = diffWindow(P_AT, P.size, undefined, (bytes) => {
        writeLe(bytes, outer, 3n);
        writeLe(bytes, set + 1 * S.keyStride, 8n);
        putFlag(bytes, set + S.flagsOffset, 1, 1);
        writeLe(bytes, set + S.populationOffset, 1n);
        writeLe(bytes, set + S.size, 1n);
        putFlag(bytes, P.flagsOffset, 3, 1);
        writeLe(bytes, P.populationOffset, 1n);
    });

    expect(await shown(NESTED, [window])).toEqual(["p[3].s[8] (new)", "p[3].s 0 → 1 entries", "p[3].x = 1 (new)", "p 0 → 1 entries"]);
});

test("an inner entry is named when its keys sit in other, non-adjacent windows", async () => {
    const outerKey = diffWindow(M_AT + M_OUTER, 8, undefined, (bytes) => writeLe(bytes, 0, 5n));
    const innerKey = diffWindow(M_AT + innerKeyAt(3), 8, undefined, (bytes) => writeLe(bytes, 0, 7n));
    const innerValue = diffWindow(M_AT + innerValueAt(3), 8, undefined, (bytes) => writeLe(bytes, 0, 9n));
    const innerFlag = diffWindow(M_AT + M_INNER + INNER.flagsOffset, 1, undefined, (bytes) => putFlag(bytes, 0, 3, 1));

    expect(await shown(NESTED, [outerKey, innerKey, innerValue, innerFlag])).toEqual(["m[5][7] = 9 (new)"]);
});

// A reader answering by offset, so each level's key can be read back on its own.
const readerAt = (answers: Record<number, number | null>) => {
    const calls: [number, number][] = [];
    const read = async (off: number, size: number) => {
        calls.push([off, size]);
        const value = answers[off];
        if (value === undefined || value === null) {
            return undefined;
        }
        const bytes = new Uint8Array(size);
        writeLe(bytes, 0, value);
        return bytes;
    };
    return { read, calls };
};

test("an inner update with no key in any window reads both keys back, once each", async () => {
    const update = diffWindow(M_AT + innerValueAt(3), 8, (bytes) => writeLe(bytes, 0, 9n), (bytes) => writeLe(bytes, 0, 10n));
    const reader = readerAt({ [M_AT + M_OUTER]: 5, [M_AT + innerKeyAt(3)]: 7 });

    expect((await stateDiffLines(NESTED, [update], reader.read)).map(flat)).toEqual(["m[5][7] 9 → 10"]);
    expect(reader.calls).toEqual([
        [M_AT + M_OUTER, 8],
        [M_AT + innerKeyAt(3), 8],
    ]);
});

test("an unresolved outer key leaves the whole entry on its physical path", async () => {
    const update = diffWindow(M_AT + innerValueAt(3), 8, (bytes) => writeLe(bytes, 0, 9n), (bytes) => writeLe(bytes, 0, 10n));
    const reader = readerAt({ [M_AT + M_OUTER]: null, [M_AT + innerKeyAt(3)]: 7 });
    const lines = await stateDiffLines(NESTED, [update], reader.read);

    expect(lines.map(flat)).toEqual(["m.slot[1].value.slot[3].value 9 → 10"]);
    expect(lines[0].keyUnresolved).toBe(true);
});

test("an inner entry whose key and value are both zero is named by its flag under the outer key", async () => {
    const window = mWindow(liveOuter, (bytes) => {
        putFlag(bytes, M_INNER + INNER.flagsOffset, 0, 1);
        writeLe(bytes, M_INNER + INNER.populationOffset, 2n);
    });

    expect(await shown(NESTED, [window])).toEqual(["m[5][0] (new)", "m[5] 1 → 2 entries"]);
});

test("a BitArray two keys down reads by both keys, and its warning names the entry", async () => {
    const outer = MB.elementStride;
    const inner = outer + MB.elementValueOffset;
    const bits = inner + 3 * BITS16.elementStride + BITS16.elementValueOffset;
    const window = diffWindow(MB_AT, MB.size, undefined, (bytes) => {
        writeLe(bytes, outer, 5n);
        putFlag(bytes, MB.flagsOffset, 1, 1);
        writeLe(bytes, MB.populationOffset, 1n);
        writeLe(bytes, inner + 3 * BITS16.elementStride, 7n);
        bytes[bits] = 1 << 3;
        bytes[bits + 2] = 1 << 4;
        putFlag(bytes, inner + BITS16.flagsOffset, 3, 1);
        writeLe(bytes, inner + BITS16.populationOffset, 1n);
    });
    const lines = await stateDiffLines(NESTED, [window]);

    expect(lines.filter((line) => !line.internal).map(flat)).toEqual([
        "mb[5][7][3] = 1 (new)",
        "mb[5][7][20] = 1 (new) (past capacity 16)",
        "mb[5] 0 → 1 entries",
        "mb 0 → 1 entries",
    ]);
    expect(pastCapacityWarnings(lines)).toEqual([
        "⚠ mb[5][7]: bit 20 written past BitArray<16> capacity — set() got an index ≥ 16, which core doesn't reject and get(i) reads back; check the index",
    ]);
});

test("a flag-only diff never reads the node", async () => {
    const flag = diffWindow(BIG_MAP_OFF + BIG_MAP_GEOMETRY.flagsOffset, 1, undefined, (bytes) => setFlag(bytes, 0, 0, 1));
    const reader = keyReaderOf(11);

    expect((await stateDiffLines(BIG_MAP, [flag], reader.read)).map(flat)).toEqual(["m._occupationFlags[0] 0 → 1"]);
    expect(reader.calls).toEqual([]);
});

// An unkeyed container under a keyed one passes the chain through: its payload and its words all read under the outer key.
const LIST = linkedListGeometry(U64, 4);
const MAPLISTS = hashMapGeometry(U64, { size: LIST.size, align: LIST.align }, 2);
const QUEUE = collectionGeometry(U64, 4);
const MAPQUEUES = hashMapGeometry(U64, { size: QUEUE.size, align: QUEUE.align }, 2);
const UNKEYED = fieldsOf("NestedUnkeyed", "HashMap<uint64, LinkedList<uint64, 4>, 2> maplists; HashMap<uint64, Collection<uint64, 4>, 2> mapqueues;");

test("a LinkedList inside a map value keeps the outer key on its node and its bookkeeping", async () => {
    const outer = MAPLISTS.elementStride;
    const list = outer + MAPLISTS.elementValueOffset;
    const window = diffWindow(offsetOf(UNKEYED, "maplists"), MAPLISTS.size, undefined, (bytes) => {
        writeLe(bytes, outer, 5n);
        putFlag(bytes, MAPLISTS.flagsOffset, 1, 1);
        writeLe(bytes, MAPLISTS.populationOffset, 1n);
        writeLe(bytes, list + LIST.nodeStride, 222n);
        writeLe(bytes, list + LIST.nodeStride + LIST.nextIndexOffset, -1n);
        writeLe(bytes, list + LIST.nodeStride + LIST.prevIndexOffset, -1n);
        bytes[list + LIST.flagsOffset] = 1 << 1;
        writeLe(bytes, list + LIST.headIndexOffset, 1n);
        writeLe(bytes, list + LIST.tailIndexOffset, 1n);
        writeLe(bytes, list + LIST.freeHeadIndexOffset, -1n);
        writeLe(bytes, list + LIST.nextUnusedIndexOffset, 2n);
        writeLe(bytes, list + LIST.populationOffset, 1n);
    });

    expect(await shown(UNKEYED, [window])).toEqual(["maplists[5][1] = 222 (new)", "maplists[5] 0 → 1 entries", "maplists 0 → 1 entries"]);
    expect(await hidden(UNKEYED, [window])).toEqual([
        "maplists.slot[1].key 0 → 5",
        "maplists[5][1].nextIndex 0 → -1",
        "maplists[5][1].prevIndex 0 → -1",
        "maplists[5]._occupiedFlags[1] 0 → 1",
        "maplists[5]._headIndex 0 → 1",
        "maplists[5]._tailIndex 0 → 1",
        "maplists[5]._freeHeadIndex 0 → -1",
        "maplists[5]._nextUnusedIndex 0 → 2",
        "maplists._occupationFlags[1] 0 → 1",
    ]);
});

test("a Collection inside a map value keeps the outer key on its element, its priority and its PoV", async () => {
    const outer = MAPQUEUES.elementStride;
    const queue = outer + MAPQUEUES.elementValueOffset;
    const element = queue + QUEUE.elementsOffset;
    const window = diffWindow(offsetOf(UNKEYED, "mapqueues"), MAPQUEUES.size, undefined, (bytes) => {
        writeLe(bytes, outer, 5n);
        putFlag(bytes, MAPQUEUES.flagsOffset, 1, 1);
        writeLe(bytes, MAPQUEUES.populationOffset, 1n);
        bytes.fill(3, queue + QUEUE.povValueOffset, queue + QUEUE.povValueOffset + 32);
        writeLe(bytes, queue + QUEUE.povPopulationOffset, 1n);
        putFlag(bytes, queue + QUEUE.flagsOffset, 0, 1);
        writeLe(bytes, element + QUEUE.elementValueOffset, 42n);
        writeLe(bytes, element + QUEUE.elementPriorityOffset, 7n);
        writeLe(bytes, element + QUEUE.elementBstParentIndexOffset, -1n);
        writeLe(bytes, queue + QUEUE.populationOffset, 1n);
    });
    const pov = await bytesToIdentity(new Uint8Array(32).fill(3));

    expect(await shown(UNKEYED, [window])).toEqual([
        `mapqueues[5].pov[0] = ${pov} (new)`,
        "mapqueues[5][0] = 42 (new)",
        "mapqueues[5][0].priority = 7 (new)",
        "mapqueues[5] 0 → 1 entries",
        "mapqueues 0 → 1 entries",
    ]);
    expect(await hidden(UNKEYED, [window])).toEqual([
        "mapqueues.slot[1].key 0 → 5",
        "mapqueues[5].pov[0].population 0 → 1",
        "mapqueues[5]._povOccupationFlags[0] 0 → 1",
        "mapqueues[5][0].bstParentIndex 0 → -1",
        "mapqueues._occupationFlags[1] 0 → 1",
    ]);
});

// add then remove inside the call that creates the outer entry: the inner flag lands on 2 with a zeroed slot, so only the flag names it — under the outer's after-image key
test("an inner slot added and removed in the call that created its outer is named by both keys from the flag alone", async () => {
    const window = mWindow(undefined, (bytes) => {
        writeLe(bytes, M_OUTER, 5n);
        putFlag(bytes, M.flagsOffset, 1, 1);
        writeLe(bytes, M.populationOffset, 1n);
        putFlag(bytes, M_INNER + INNER.flagsOffset, 0, 2);
        writeLe(bytes, M_INNER + INNER.markRemovalCounterOffset, 1n);
    });

    expect(await shown(NESTED, [window])).toEqual(["m[5][0] (removed)", "m 0 → 1 entries"]);
});
