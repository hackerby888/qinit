// Every changed byte window has to resolve back to the field, element and member it covers — that is the
// whole difference between a trace that reads like `qinit state` and one that reads like a hex dump.
import { test, expect } from "bun:test";
import { extractIdl } from "@qinit/build";
import { stateFieldsOf } from "../../src/trace/format";
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
    LinkedList<uint64, 8> list;
    BitArray<64> bits;
  };
  INITIALIZE() {}
};`;

const FIELDS = stateFieldsOf(extractIdl(SRC, "Layout", { slot: 7 }));
const STATE_SIZE = 512;
const offsetOf = (name: string) => FIELDS.find((field) => field.name === name)!.off;

const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

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

const rowsFor = async (
  write: (after: Uint8Array) => void,
  span: { off: number; length: number },
) => {
  const before = new Uint8Array(STATE_SIZE);
  const after = before.slice();
  write(after);

  const lines = await stateDiffLines(FIELDS, [region(before, after, span.off, span.length)]);
  return lines.map((line) => `${line.label} ${line.text}`);
};

test("a scalar field decodes to its value", async () => {
  expect(await rowsFor((after) => writeLe(after, 0, 92, 8), { off: 0, length: 8 })).toEqual([
    "counter 0 → 92",
  ]);
});

test("an array element is named by index, not by byte offset", async () => {
  const nums = offsetOf("nums");
  expect(
    await rowsFor((after) => writeLe(after, nums + 3 * 8, 3195, 8), { off: nums, length: 64 }),
  ).toEqual(["nums[3] 0 → 3195"]);
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

// A HashMap write touches the record, the occupation flags and the population counter.
test("HashMap internals resolve to slot, flags and population", async () => {
  const map = offsetOf("map");
  const rows = await rowsFor(
    (after) => {
      writeLe(after, map + 4 * 16, 11, 8); // slot 4 key
      writeLe(after, map + 4 * 16 + 8, 101, 8); // slot 4 value
      after[map + 128 + 1] = 1 << 0; // slot 4 occupied (two-bit flags)
      writeLe(after, map + 136, 1, 8); // population
    },
    { off: map, length: 152 },
  );

  expect(rows).toEqual([
    "map.slot[4].key 0 → 11",
    "map.slot[4].value 0 → 101",
    "map._occupationFlags[4] 0 → 1",
    "map._population 0 → 1",
  ]);
});

test("LinkedList internals resolve to node members and list head", async () => {
  const list = offsetOf("list");
  const rows = await rowsFor(
    (after) => {
      writeLe(after, list + 1 * 24, 66, 8); // node 1 value
      writeLe(after, list + 1 * 24 + 8, -1, 8); // node 1 next
      after[list + 192] = 1 << 1; // node 1 occupied (one-bit flags)
      writeLe(after, list + 200, 1, 8); // head
      writeLe(after, list + 232, 1, 8); // population
    },
    { off: list, length: 240 },
  );

  expect(rows).toEqual([
    "list._nodes[1].value 0 → 66",
    "list._nodes[1].next 0 → -1",
    "list._occupationFlags[1] 0 → 1",
    "list._head 0 → 1",
    "list._population 0 → 1",
  ]);
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

  const split = [
    region(before, after, points + 8, 4),
    region(before, after, points + 12, 4),
  ];
  const lines = await stateDiffLines(FIELDS, split);

  expect(lines.map((line) => `${line.label} ${line.text}`)).toEqual([
    "points[1] 0 → {x: 508, y: 842}",
  ]);
});

// A core node reports minimal runs, so a value can arrive without the bytes that did not change.
test("a run that does not cover a whole value keeps its bytes", async () => {
  const nums = offsetOf("nums");
  expect(
    await rowsFor((after) => writeLe(after, nums + 8, 3195, 8), { off: nums + 8, length: 2 }),
  ).toEqual(["nums[1]+0 0x0000 → 0x7b0c"]);
});
