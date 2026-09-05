// Windows the engine cannot aim on purpose: one opening inside a struct element ahead of the member
// that moved, one covering a struct that holds a container, entries that leave nothing but a flag
// behind, packed values inside keyed records, nested and negative keys. Each pins the rows a dev reads.
import { expect, test } from "bun:test";
import { collectionGeometry, hashMapGeometry, hashSetGeometry } from "@qinit/proto/qpi-layout";
import { stateDiffLines, type StateDiffLine } from "../../src/trace/state-diff";
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
    // Order's last four bytes are padding. Opening 24 bytes into element 1 used to make the padding step
    // resolve to the whole struct, whose partial image then repeated the change as a raw hex row.
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
    writeLe(bytes, at + slot * MAP.recordStride, key);
    writeLe(bytes, at + slot * MAP.recordStride + MAP.valueOffset, value);
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
        writeLe(bytes, MAP.size + 2 * SET.recordStride, 2n);
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
        writeLe(bytes, byKey + KEY.recordStride, 1n);
        writeLe(bytes, byKey + KEY.recordStride + 8, 2n);
        writeLe(bytes, byKey + KEY.recordStride + 16, 3n, 4);
        writeLe(bytes, byKey + KEY.recordStride + KEY.valueOffset, 4n);
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
    const record = BITS.recordStride;
    const arrived = diffWindow(0, BITS.size, undefined, (bytes) => {
        writeLe(bytes, record, 1n);
        bytes[record + BITS.valueOffset] = 1 << 3;
        bytes[record + BITS.valueOffset + 7] = 0x80;
        setFlag(bytes, BITS.flagsOffset, 1, 1);
        writeLe(bytes, BITS.populationOffset, 1n);
    });
    const changed = diffWindow(
        0,
        BITS.size,
        (bytes) => {
            writeLe(bytes, record, 1n);
            bytes[record + BITS.valueOffset] = 1 << 3;
            setFlag(bytes, BITS.flagsOffset, 1, 1);
            writeLe(bytes, BITS.populationOffset, 1n);
        },
        (bytes) => {
            bytes[record + BITS.valueOffset + 7] = 0x80;
        },
    );

    expect(await shown(fields, [arrived])).toEqual(["bitValues[1][3] = 1 (new)", "bitValues[1][63] = 1 (new)", "bitValues 0 → 1 entries"]);
    expect(await hidden(fields, [arrived])).toEqual(["bitValues.slot[1].key 0 → 1", "bitValues._occupationFlags[1] 0 → 1"]);
    expect(await shown(fields, [changed])).toEqual(["bitValues[1][63] 0 → 1"]);
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
    // Rec pads 4..8 and 20..24. Opening in the first pad used to size the padding step to the struct's end,
    // so b and d were walked over without a row.
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
