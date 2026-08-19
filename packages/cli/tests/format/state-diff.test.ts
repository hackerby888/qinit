// Every changed byte window has to resolve back to the field, element and member it covers — that is the
// whole difference between a trace that reads like `qinit state` and one that reads like a hex dump.
import { test, expect } from "bun:test";
import { extractIdl } from "@qinit/build";
import { stateFieldsOf } from "../../src/trace/state-format";
import { stateDiffLines } from "../../src/trace/state-diff";

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Point { sint32 x; sint32 y; };
  struct StateData {
    uint64 counter;
    Array<uint64, 8> nums;
    Array<Point, 4> points;
    HashMap<uint64, uint64, 8> map;
    HashSet<uint64, 8> set;
    LinkedList<uint64, 8> list;
    BitArray<64> bits;
  };
  INITIALIZE() {}
};`;

const FIELDS = stateFieldsOf(extractIdl(SRC, "Layout", { slot: 7 }));
const STATE_SIZE = 768;
const offsetOf = (name: string) => FIELDS.find((field) => field.name === name)!.off;

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function writeLe(bytes: Uint8Array, offset: number, value: number, width: number) {
    let rest = BigInt(value);
    for (let index = 0; index < width; index++) {
        bytes[offset + index] = Number(rest & 0xffn);
        rest >>= 8n;
    }
}

// One region per changed span, the way both backends report them.
const region = (before: Uint8Array, after: Uint8Array, off: number, length: number) => ({
    off,
    before: hex(before.slice(off, off + length)),
    after: hex(after.slice(off, off + length)),
});

const linesFor = async (write: (after: Uint8Array) => void, span: { off: number; length: number }) => {
    const before = new Uint8Array(STATE_SIZE);
    const after = before.slice();
    write(after);

    return stateDiffLines(FIELDS, [region(before, after, span.off, span.length)]);
};

// The default view's form: the short label the reader sees, and its text.
const rowsFor = async (write: (after: Uint8Array) => void, span: { off: number; length: number }) =>
    (await linesFor(write, span)).map((line) => `${line.label} ${line.text}`);

test("a scalar field decodes to its value", async () => {
    expect(await rowsFor((after) => writeLe(after, 0, 92, 8), { off: 0, length: 8 })).toEqual(["counter 0 → 92"]);
});

test("an array element is named by index, not by byte offset", async () => {
    const nums = offsetOf("nums");
    expect(await rowsFor((after) => writeLe(after, nums + 3 * 8, 3195, 8), { off: nums, length: 64 })).toEqual(["nums[3] 0 → 3195"]);
});

test("a struct element decodes whole, with its member names", async () => {
    const points = offsetOf("points");
    expect(
        await rowsFor(
            (after) => {
                writeLe(after, points + 2 * 8, 508, 4);
                writeLe(after, points + 2 * 8 + 4, 842, 4);
            },
            { off: points, length: 32 },
        ),
    ).toEqual(["points[2] 0 → {x: 508, y: 842}"]);
});

// A HashMap write touches the record, the occupation flags and the population counter. The record reads as
// one entry named by its key; the bucket it hashed into stays on the full path, with the flags, below.
test("a HashMap insert reads as one entry named by its key", async () => {
    const map = offsetOf("map");
    const lines = await linesFor(
        (after) => {
            writeLe(after, map + 4 * 16, 11, 8); // slot 4 key
            writeLe(after, map + 4 * 16 + 8, 101, 8); // slot 4 value
            after[map + 128 + 1] = 1 << 0; // slot 4 occupied (two-bit flags)
            writeLe(after, map + 136, 1, 8); // population
        },
        { off: map, length: 152 },
    );

    expect(lines).toEqual([
        {
            label: "map.slot[4].key",
            detail: "map.slot[4].key",
            text: "0 → 11",
            filled: true,
            internal: true,
        },
        {
            label: "map[11]",
            detail: "map.slot[4].value",
            text: "= 101 (new)",
            filled: true,
            internal: false,
        },
        {
            label: "map._occupationFlags[4]",
            detail: "map._occupationFlags[4]",
            text: "0 → 1",
            filled: true,
            internal: true,
        },
        {
            label: "map",
            detail: "map._population",
            text: "0 → 1 entries",
            filled: true,
            internal: false,
        },
    ]);
});

// A HashSet slot is the key alone, with no value member below it, so the key row is what carries the entry.
test("a HashSet insert reads as one entry named by its key", async () => {
    const set = offsetOf("set");
    const lines = await linesFor(
        (after) => {
            writeLe(after, set + 4 * 8, 11, 8); // slot 4 key
            after[set + 64 + 1] = 1 << 0; // slot 4 occupied (two-bit flags)
            writeLe(after, set + 72, 1, 8); // population
        },
        { off: set, length: 88 },
    );

    expect(lines.map((line) => [line.label, line.detail, line.text, line.internal])).toEqual([
        ["set[11]", "set.slot[4]", "(new)", false],
        ["set._occupationFlags[4]", "set._occupationFlags[4]", "0 → 1", true],
        ["set", "set._population", "0 → 1 entries", false],
    ]);
});

// An entry's own history — an update, a removal, a reused tombstone — needs a before image that already
// holds something, so these seed the state instead of starting from zero.
const MAP = offsetOf("map");
const MAP_FLAGS = MAP + 128;
const MAP_POPULATION = MAP + 136;
const WHOLE_MAP = { off: MAP, length: 152 };
const mapKey = (slot: number) => MAP + slot * 16;
const mapValue = (slot: number) => mapKey(slot) + 8;

// 0b00 free, 0b01 occupied, 0b10 occupied but marked for removal — two bits per slot, as core packs them.
const setFlag = (state: Uint8Array, slot: number, value: number) => {
    const bit = slot * 2;
    const index = MAP_FLAGS + (bit >> 3);
    state[index] = (state[index] & ~(3 << (bit & 7))) | (value << (bit & 7));
};

const changeRows = async (seed: (state: Uint8Array) => void, write: (after: Uint8Array) => void, spans: { off: number; length: number }[]) => {
    const before = new Uint8Array(STATE_SIZE);
    seed(before);
    const after = before.slice();
    write(after);

    const lines = await stateDiffLines(
        FIELDS,
        spans.map((span) => region(before, after, span.off, span.length)),
    );
    return lines.map((line) => [line.label, line.text, line.internal]);
};

const liveEntry = (state: Uint8Array) => {
    writeLe(state, mapKey(4), 11, 8);
    writeLe(state, mapValue(4), 101, 8);
    setFlag(state, 4, 1);
    writeLe(state, MAP_POPULATION, 1, 8);
};

// Nothing about the slot changes on an update, so the key never gets a row of its own — it is read from the
// window instead, which is the only reason the line can still name it.
test("a HashMap update names the live key and keeps the arrow", async () => {
    expect(await changeRows(liveEntry, (after) => writeLe(after, mapValue(4), 202, 8), [WHOLE_MAP])).toEqual([["map[11]", "101 → 202", false]]);
});

// removeByIndex zero-fills the record, so the key that names the line only survives in the before image.
test("a removed entry is named by the key it held", async () => {
    const rows = await changeRows(
        liveEntry,
        (after) => {
            writeLe(after, mapKey(4), 0, 8);
            writeLe(after, mapValue(4), 0, 8);
            setFlag(after, 4, 2);
            writeLe(after, MAP_POPULATION, 0, 8);
        },
        [WHOLE_MAP],
    );

    expect(rows).toEqual([
        ["map.slot[4].key", "11 → 0", true],
        ["map[11]", "101 → (removed)", false],
        ["map._occupationFlags[4]", "1 → 2", true],
        ["map", "1 → 0 entries", false],
    ]);
});

test("a slot reused from a tombstone still reads as a new entry", async () => {
    const rows = await changeRows(
        (state) => setFlag(state, 4, 2),
        (after) => {
            writeLe(after, mapKey(4), 11, 8);
            writeLe(after, mapValue(4), 101, 8);
            setFlag(after, 4, 1);
            writeLe(after, MAP_POPULATION, 1, 8);
        },
        [WHOLE_MAP],
    );

    expect(rows).toEqual([
        ["map.slot[4].key", "0 → 11", true],
        ["map[11]", "= 101 (new)", false],
        ["map._occupationFlags[4]", "2 → 1", true],
        ["map", "0 → 1 entries", false],
    ]);
});

test("a slot vacated outright is named by the key it held", async () => {
    const rows = await changeRows(
        liveEntry,
        (after) => {
            writeLe(after, mapKey(4), 0, 8);
            writeLe(after, mapValue(4), 0, 8);
            setFlag(after, 4, 0);
            writeLe(after, MAP_POPULATION, 0, 8);
        },
        [WHOLE_MAP],
    );

    expect(rows).toEqual([
        ["map.slot[4].key", "11 → 0", true],
        ["map[11]", "101 → 0", false],
        ["map._occupationFlags[4]", "1 → 0", true],
        ["map", "1 → 0 entries", false],
    ]);
});

// A zero value writes no bytes that differ, so there is no value row to carry the entry and the key row has
// to. Without that the insert would show up as nothing but a population bump.
test("an entry whose value stays zero is still reported", async () => {
    const rows = await changeRows(
        () => {},
        (after) => {
            writeLe(after, mapKey(4), 45, 8);
            setFlag(after, 4, 1);
            writeLe(after, MAP_POPULATION, 1, 8);
        },
        [WHOLE_MAP],
    );

    expect(rows).toEqual([
        ["map[45]", "(new)", false],
        ["map._occupationFlags[4]", "0 → 1", true],
        ["map", "0 → 1 entries", false],
    ]);
});

// A core node reports the bytes that changed, so an update can arrive without the key that would name it.
test("a window without the key leaves the row on its resolved path", async () => {
    expect(await changeRows(liveEntry, (after) => writeLe(after, mapValue(4), 202, 8), [{ off: mapValue(4), length: 8 }])).toEqual([
        ["map.slot[4].value", "101 → 202", false],
    ]);
});

test("two entries written in one call keep their own keys", async () => {
    const rows = await changeRows(
        () => {},
        (after) => {
            writeLe(after, mapKey(4), 11, 8);
            writeLe(after, mapValue(4), 101, 8);
            setFlag(after, 4, 1);
            writeLe(after, mapKey(6), 13, 8);
            writeLe(after, mapValue(6), 103, 8);
            setFlag(after, 6, 1);
            writeLe(after, MAP_POPULATION, 2, 8);
        },
        [WHOLE_MAP],
    );

    expect(rows).toEqual([
        ["map.slot[4].key", "0 → 11", true],
        ["map[11]", "= 101 (new)", false],
        ["map.slot[6].key", "0 → 13", true],
        ["map[13]", "= 103 (new)", false],
        ["map._occupationFlags[4]", "0 → 1", true],
        ["map._occupationFlags[6]", "0 → 1", true],
        ["map", "0 → 2 entries", false],
    ]);
});

test("LinkedList internals resolve to node members and list head", async () => {
    const list = offsetOf("list");
    const lines = await linesFor(
        (after) => {
            writeLe(after, list + 1 * 24, 66, 8); // node 1 value
            writeLe(after, list + 1 * 24 + 8, -1, 8); // node 1 next
            after[list + 192] = 1 << 1; // node 1 occupied (one-bit flags)
            writeLe(after, list + 200, 1, 8); // head
            writeLe(after, list + 232, 1, 8); // population
        },
        { off: list, length: 240 },
    );

    expect(lines.map((line) => [line.label, line.detail, line.text, line.internal])).toEqual([
        ["list[1]", "list._nodes[1].value", "0 → 66", false],
        ["list[1].nextIndex", "list._nodes[1].nextIndex", "0 → -1", true],
        ["list._occupiedFlags[1]", "list._occupiedFlags[1]", "0 → 1", true],
        ["list._headIndex", "list._headIndex", "0 → 1", true],
        ["list", "list._population", "0 → 1 entries", false],
    ]);
});

// A call that only reshuffles a list's links still wrote state — the view must not read as "no change".
test("a write that touches only bookkeeping resolves to internal rows", async () => {
    const list = offsetOf("list");
    const lines = await linesFor(
        (after) => {
            writeLe(after, list + 208, 3, 8); // tail
            writeLe(after, list + 224, 4, 8); // nextUnused
        },
        { off: list + 200, length: 40 },
    );

    expect(lines.map((line) => line.detail)).toEqual(["list._tailIndex", "list._nextUnusedIndex"]);
    expect(lines.every((line) => line.internal)).toBe(true);
});

// Printing every bit of a BitArray twice to show one flip is exactly the noise this replaces.
test("a BitArray reports the bits that flipped", async () => {
    const bits = offsetOf("bits");
    expect(
        await rowsFor(
            (after) => {
                after[bits] = 1 << 3;
                after[bits + 2] = 1 << 1;
            },
            { off: bits, length: 8 },
        ),
    ).toEqual(["bits[3] 0 → 1", "bits[17] 0 → 1"]);
});

// Core reports one region per dirty page, so a record crossing a page boundary arrives in two pieces.
test("contiguous regions are joined before resolving", async () => {
    const points = offsetOf("points");
    const before = new Uint8Array(STATE_SIZE);
    const after = before.slice();
    writeLe(after, points + 8, 508, 4);
    writeLe(after, points + 12, 842, 4);

    const split = [region(before, after, points + 8, 4), region(before, after, points + 12, 4)];
    const lines = await stateDiffLines(FIELDS, split);

    expect(lines.map((line) => `${line.label} ${line.text}`)).toEqual(["points[1] 0 → {x: 508, y: 842}"]);
});

// A core node reports minimal runs, so a value can arrive without the bytes that did not change.
test("a run that does not cover a whole value keeps its bytes", async () => {
    const nums = offsetOf("nums");
    expect(await rowsFor((after) => writeLe(after, nums + 8, 3195, 8), { off: nums + 8, length: 2 })).toEqual(["nums[1]+0 0x0000 → 0x7b0c"]);
});

// A value under 8 bytes leaves padding before the next member. That pad has to resolve forward, to the
// member after it — resolving it back to the value re-reports the value once per padding byte.
const PADDED_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    LinkedList<uint32, 8> list;
    Collection<uint32, 4> queue;
  };
  INITIALIZE() {}
};`;

const PADDED_FIELDS = stateFieldsOf(extractIdl(PADDED_SRC, "Padded", { slot: 7 }));
const paddedOffsetOf = (name: string) => PADDED_FIELDS.find((field) => field.name === name)!.off;

test("a node value smaller than its slot is reported once", async () => {
    const list = paddedOffsetOf("list");
    const before = new Uint8Array(1024);
    const after = before.slice();
    writeLe(after, list + 24, 7, 4); // node 1 value; the node stride is 24, with 4 pad bytes after it

    const lines = await stateDiffLines(PADDED_FIELDS, [region(before, after, list, 48)]);

    expect(lines.map((line) => [line.label, line.detail, line.text])).toEqual([["list[1]", "list._nodes[1].value", "0 → 7"]]);
});

// The padding after a Collection element's value used to fall back to the whole element, so a value write
// was reported twice: once decoded, and again as the 8 bytes it shares with the pad read as a sint64.
test("a Collection element value smaller than its slot is reported once", async () => {
    const queue = paddedOffsetOf("queue");
    const elements = queue + 4 * 64 + 8; // PoV records, then the occupation flags
    const before = new Uint8Array(1024);
    const after = before.slice();
    writeLe(after, elements + 48, 9, 4); // element 1 value; the element stride is 48

    const lines = await stateDiffLines(PADDED_FIELDS, [region(before, after, elements, 96)]);

    expect(lines.map((line) => [line.label, line.detail, line.text])).toEqual([["queue[1]", "queue._elements[1].value", "0 → 9"]]);
});

// Packed flags run past one 256-byte window as soon as a container is big, and core reports the window
// that changed, not the run that contains it. Resolving from the run's start dropped every such row.
const BIG_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    HashMap<uint64, uint64, 4096> big;
    BitArray<4096> wide;
  };
  INITIALIZE() {}
};`;

const BIG_FIELDS = stateFieldsOf(extractIdl(BIG_SRC, "Big", { slot: 7 }));
const BIG_STATE_SIZE = 68000;
const bigOffsetOf = (name: string) => BIG_FIELDS.find((field) => field.name === name)!.off;

const bigRowsFor = async (write: (after: Uint8Array) => void, span: { off: number; length: number }) => {
    const before = new Uint8Array(BIG_STATE_SIZE);
    const after = before.slice();
    write(after);

    const lines = await stateDiffLines(BIG_FIELDS, [region(before, after, span.off, span.length)]);
    return lines.map((line) => `${line.label} ${line.text}`);
};

test("an occupation flag reports from a window that opens inside the flags", async () => {
    const flags = bigOffsetOf("big") + 4096 * 16; // the records come first, then the flags
    const window = flags + 512; // a 256-byte block well past the start of the run

    expect(await bigRowsFor((after) => (after[flags + 750] = 1), { off: window, length: 256 })).toEqual(["big._occupationFlags[3000] 0 → 1"]);
});

test("a BitArray reports from a window that opens past its first block", async () => {
    const wide = bigOffsetOf("wide");

    expect(await bigRowsFor((after) => (after[wide + 375] = 1), { off: wide + 256, length: 256 })).toEqual(["wide[3000] 0 → 1"]);
});

// A window can stop inside a struct value, and an id key is what a real contract keys a map by — both have
// to survive being folded onto one entry line.
const KEYED_SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct AB { uint64 a; uint64 b; };
  struct StateData {
    HashMap<uint64, AB, 8> ab;
    HashMap<id, uint64, 8> owners;
  };
  INITIALIZE() {}
};`;

const KEYED_FIELDS = stateFieldsOf(extractIdl(KEYED_SRC, "Keyed", { slot: 7 }));
const keyedOffsetOf = (name: string) => KEYED_FIELDS.find((field) => field.name === name)!.off;

test("a struct value reported in parts keeps its member on the entry line", async () => {
    const ab = keyedOffsetOf("ab");
    const before = new Uint8Array(1024);
    const after = before.slice();
    writeLe(after, ab + 4 * 24, 11, 8); // slot 4 key
    writeLe(after, ab + 4 * 24 + 8, 5, 8); // slot 4 value.a; value.b falls outside the window
    after[ab + 192 + 1] = 1 << 0;
    writeLe(after, ab + 200, 1, 8);

    const lines = await stateDiffLines(KEYED_FIELDS, [region(before, after, ab + 96, 16), region(before, after, ab + 192, 16)]);

    expect(lines.map((line) => [line.label, line.detail, line.text])).toEqual([
        ["ab.slot[4].key", "ab.slot[4].key", "0 → 11"],
        ["ab[11].a", "ab.slot[4].value.a", "= 5 (new)"],
        ["ab._occupationFlags[4]", "ab._occupationFlags[4]", "0 → 1"],
        ["ab", "ab._population", "0 → 1 entries"],
    ]);
});

test("an id key labels the entry the way qinit state does", async () => {
    const owners = keyedOffsetOf("owners");
    const before = new Uint8Array(1024);
    const after = before.slice();
    after.fill(7, owners + 4 * 40, owners + 4 * 40 + 32); // slot 4 key
    writeLe(after, owners + 4 * 40 + 32, 9, 8); // slot 4 value
    after[owners + 320 + 1] = 1 << 0;
    writeLe(after, owners + 328, 1, 8);

    const lines = await stateDiffLines(KEYED_FIELDS, [region(before, after, owners, 344)]);

    // The full identity, as `qinit state` prints it — a long label beats a bucket index that means nothing.
    const owner = "FXHSWSJBTCZHFAFXHSWSJBTCZHFAFXHSWSJBTCZHFAFXHSWSJBTCZHFAYKSC";
    expect(lines.map((line) => [line.label, line.text])).toEqual([
        ["owners.slot[4].key", `0 → ${owner}`],
        [`owners[${owner}]`, "= 9 (new)"],
        ["owners._occupationFlags[4]", "0 → 1"],
        ["owners", "0 → 1 entries"],
    ]);
});
