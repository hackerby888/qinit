import { test, expect } from "bun:test";
import {
  describeTrace,
  readState,
  fmtDiffVal,
  type StateReader,
  type StateField,
} from "../../src/trace/format";

// LE bytes / hex helpers
const le = (n: bigint | number, w: number) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const b: number[] = [];
  for (let i = 0; i < w; i++) {
    b.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return b;
};
const hx = (b: number[]) => b.map((x) => (x & 0xff).toString(16).padStart(2, "0")).join("");
// HashMap<id,uint64,4> with slot0 -> value (key = all-zero id): element stride 40, value@32, flags@160
const hashmapBuf = (value: number) => {
  const buf = new Array(176).fill(0);
  le(value, 8).forEach((x, i) => (buf[32 + i] = x));
  buf[160] = 1;
  le(1, 8).forEach((x, i) => (buf[168 + i] = x));
  return buf;
};

const SRC = `
using namespace QPI;
enum Kind { Started = 0, Bumped = 1 };
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; HashMap<id, uint64, 4> bal; };
  struct LogMsg { uint32 _contractIndex; uint32 _type; uint64 value; sint8 _terminator; };
  struct Inc_input { uint64 by; }; struct Inc_output {};
  PUBLIC_PROCEDURE(Inc) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Inc, 1); }
  INITIALIZE() {}
};`;

type StateReadCall = { slot: number; off: number; len: number };

// Range-aware state image: callers receive exactly the requested bytes or a short read.
const fakeRpc = (
  state: Uint8Array | number[],
  calls: StateReadCall[] = [],
): StateReader => {
  const bytes = Uint8Array.from(state);
  return {
    stateRead: async (slot, off, len) => {
      calls.push({ slot, off, len });
      return { hex: hx(Array.from(bytes.subarray(off, off + len))) };
    },
  };
};

test("describeTrace: decodes proc input, caller, log _type enum name, and container contents", async () => {
  const entry: any = {
    seq: 1,
    tick: 10,
    index: 7,
    entry: 1,
    kind: 1,
    ok: true,
    execNs: 1000,
    invocator: "11".repeat(32),
    invocationReward: 0,
    inHex: hx(le(5, 8)), // by = 5
    outHex: "",
    stateDiff: [],
    hostCalls: [],
    logs: [{ type: 6, size: 16, hex: hx([...le(0, 4), ...le(1, 4), ...le(9, 8)]) }], // _type=1, value=9
  };
  const v = await describeTrace(
    entry,
    SRC,
    "Counter",
    fakeRpc([...le(0, 8), ...hashmapBuf(42)]),
  );
  expect(v.inDecoded).toBe('"5"'); // single-field input -> scalar (bigint as json string)
  expect(v.caller.length).toBe(60); // proc -> 60-char identity
  expect(v.logs).toHaveLength(1);
  expect(v.logs[0].typeName).toBe("Bumped"); // enum Kind: 1 -> Bumped
  expect(v.logs[0].fields).toEqual({ _contractIndex: 0, _type: 1, value: 9n });
  expect(v.containers).toHaveLength(1);
  expect(v.containers[0].name).toBe("bal");
  expect(v.containers[0].entries[0]).toContain("42");
});

test("describeTrace: no source -> raw hex passthrough, no decode", async () => {
  const entry: any = {
    seq: 2,
    tick: 1,
    index: 0,
    entry: 1,
    kind: 0,
    ok: true,
    execNs: 0,
    invocator: "0".repeat(64),
    invocationReward: 0,
    inHex: "abcd",
    outHex: "",
    stateDiff: [],
    hostCalls: [],
    logs: [],
  };
  const v = await describeTrace(entry, undefined, "X", fakeRpc([]));
  expect(v.inDecoded).toBe("0xabcd");
  expect(v.caller).toBe("(none)");
  expect(v.containers).toHaveLength(0);
});

test("readState: scalar fields decoded + container entries", async () => {
  const state = await readState(
    fakeRpc([...le(7, 8), ...hashmapBuf(42)]),
    7,
    SRC,
    "Counter",
  );
  expect(state.fields).toEqual([{ name: "counter", value: "7" }]); // bal is a container -> not a scalar
  expect(state.complete).toBe(true);
  expect(state.containers).toHaveLength(1);
  expect(state.containers[0].name).toBe("bal");
  expect(state.containers[0].entries[0]).toContain("42");
});

test("readState: reads a complete sparse array across the 256 KiB boundary", async () => {
  const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { Array<uint64, 32769> values; }; INITIALIZE() {} };`;
  const bytes = new Uint8Array(32769 * 8);
  bytes.set(le(7, 8), 8);
  bytes.set(le(9, 8), 32768 * 8);
  const calls: StateReadCall[] = [];
  const progress: [string, number, number][] = [];

  const state = await readState(
    fakeRpc(bytes, calls),
    7,
    source,
    "Big",
    undefined,
    (field, completed, total) => progress.push([field, completed, total]),
  );

  expect(state.fields).toEqual([
    {
      name: "values",
      value:
        "[0]=0 (skipped), [1]=7, [2..32767]=0 ×32766 (skipped), [32768]=9",
    },
  ]);
  expect(state.complete).toBe(true);
  expect(calls).toEqual([
    { slot: 7, off: 0, len: 262144 },
    { slot: 7, off: 262144, len: 8 },
  ]);
  expect(progress).toEqual([
    ["values", 0, 262152],
    ["values", 262144, 262152],
    ["values", 262152, 262152],
  ]);
});

test("readState: BitArray reads compact words in pages and renders logical bits", async () => {
  const bitCount = 4_194_304;
  const bytes = new Uint8Array(bitCount / 8);
  bytes[262143] = 0x80;
  bytes[262144] = 0x01;
  const calls: StateReadCall[] = [];
  const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { BitArray<${bitCount}> bits; }; INITIALIZE() {} };`;

  const state = await readState(
    fakeRpc(bytes, calls),
    9,
    source,
    "LargeBits",
  );

  expect(calls).toEqual([
    { slot: 9, off: 0, len: 262144 },
    { slot: 9, off: 262144, len: 262144 },
  ]);
  expect(state.fields).toEqual([
    {
      name: "bits",
      value:
        "[0..2097150]=0 ×2097151 (skipped), [2097151]=1, [2097152]=1, [2097153..4194303]=0 ×2097151 (skipped)",
    },
  ]);
  expect(state.complete).toBe(true);
});

test("readState: BitArray ignores high padding bits", async () => {
  const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { BitArray<2> bits; }; INITIALIZE() {} };`;
  const calls: StateReadCall[] = [];
  const bytes = new Uint8Array(8).fill(0xff);

  const state = await readState(
    fakeRpc(bytes, calls),
    2,
    source,
    "SmallBits",
  );

  expect(calls).toEqual([{ slot: 2, off: 0, len: 8 }]);
  expect(state.fields).toEqual([
    { name: "bits", value: "[0]=1, [1]=1" },
  ]);
});

test("readState: nested BitArray keeps one-field struct boundaries", async () => {
  const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct Bits { BitArray<128> value; }; struct Box { Bits bits; }; struct StateData { Box nested; }; INITIALIZE() {} };`;
  const bytes = new Uint8Array(16);
  bytes[7] = 0x80;

  const state = await readState(
    fakeRpc(bytes),
    2,
    source,
    "NestedBits",
  );

  expect(state.fields).toEqual([
    {
      name: "nested",
      value:
        "[[0..62]=0 ×63 (skipped), [63]=1, [64..127]=0 ×64 (skipped)]",
    },
  ]);
});

const HASHMAP_SOURCE = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashMap<uint64, uint64, 8> values; }; INITIALIZE() {} };`;

test("readState: an empty HashMap only reads population", async () => {
  const calls: StateReadCall[] = [];
  const state = await readState(
    fakeRpc(new Uint8Array(152), calls),
    3,
    HASHMAP_SOURCE,
    "EmptyMap",
  );

  expect(calls).toEqual([{ slot: 3, off: 136, len: 8 }]);
  expect(state.complete).toBe(true);
  expect(state.containers).toEqual([
    {
      name: "values",
      kind: "hashmap",
      capacity: 8,
      occupiedSlots: 0,
      totalEntries: 0,
      entries: ["slots[0..7] (unoccupied ×8; skipped)"],
    },
  ]);
});

test("readState: a sparse HashMap fetches only occupied record ranges", async () => {
  const bytes = new Uint8Array(152);
  bytes.set(le(1n << 2n | 1n << 4n | 1n << 12n, 8), 128);
  bytes.set(le(3, 8), 136);
  for (const [slot, key, value] of [
    [1, 11, 101],
    [2, 22, 202],
    [6, 66, 606],
  ]) {
    bytes.set(le(key, 8), slot * 16);
    bytes.set(le(value, 8), slot * 16 + 8);
  }
  const calls: StateReadCall[] = [];
  const state = await readState(
    fakeRpc(bytes, calls),
    4,
    HASHMAP_SOURCE,
    "SparseMap",
  );

  expect(calls).toEqual([
    { slot: 4, off: 136, len: 8 },
    { slot: 4, off: 128, len: 8 },
    { slot: 4, off: 16, len: 32 },
    { slot: 4, off: 96, len: 16 },
  ]);
  expect(state.complete).toBe(true);
  expect(state.containers).toEqual([
    {
      name: "values",
      kind: "hashmap",
      capacity: 8,
      occupiedSlots: 3,
      totalEntries: 3,
      entries: [
        "slot[0] (unoccupied ×1; skipped)",
        "slot[1] \"11\" = 101",
        "slot[2] \"22\" = 202",
        "slots[3..5] (unoccupied ×3; skipped)",
        "slot[6] \"66\" = 606",
        "slot[7] (unoccupied ×1; skipped)",
      ],
    },
  ]);
});

test("readState: BitArray values inside HashMap use logical bit ranges", async () => {
  const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashMap<uint64, BitArray<128>, 4> values; }; INITIALIZE() {} };`;
  const bytes = new Uint8Array(120);
  bytes.set(le(7, 8), 48); // slot 2 key
  bytes[63] = 0x80; // slot 2 value bit 63
  bytes[96] = 1 << 4; // slot 2 occupied (two-bit flag)
  bytes.set(le(1, 8), 104);
  const calls: StateReadCall[] = [];

  const state = await readState(
    fakeRpc(bytes, calls),
    6,
    source,
    "MapBits",
  );

  expect(calls).toEqual([
    { slot: 6, off: 104, len: 8 },
    { slot: 6, off: 96, len: 8 },
    { slot: 6, off: 48, len: 24 },
  ]);
  expect(state.containers[0].entries).toEqual([
    "slots[0..1] (unoccupied ×2; skipped)",
    "slot[2] \"7\" = [0..62]=0 ×63 (skipped), [63]=1, [64..127]=0 ×64 (skipped)",
    "slot[3] (unoccupied ×1; skipped)",
  ]);
});

test("readState: LinkedList values inside HashMap stay semantic", async () => {
  const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashMap<uint64, LinkedList<uint64, 4>, 4> values; }; INITIALIZE() {} };`;
  const bytes = new Uint8Array(632);
  bytes.set(le(5, 8), 152); // outer slot 1 key
  bytes.set(le(9, 8), 208); // nested slot 2 value
  bytes.set(le(-1, 8), 216); // nested next
  bytes.set(le(-1, 8), 224); // nested previous
  bytes[256] = 1 << 2; // nested slot 2 occupied
  bytes.set(le(2, 8), 264); // nested head
  bytes.set(le(2, 8), 272); // nested tail
  bytes.set(le(1, 8), 296); // nested population
  bytes[608] = 1 << 2; // outer slot 1 occupied (two-bit flag)
  bytes.set(le(1, 8), 616); // outer population
  const calls: StateReadCall[] = [];

  const state = await readState(
    fakeRpc(bytes, calls),
    7,
    source,
    "MapLists",
  );

  expect(calls).toEqual([
    { slot: 7, off: 616, len: 8 },
    { slot: 7, off: 608, len: 8 },
    { slot: 7, off: 152, len: 152 },
  ]);
  expect(state.containers[0].entries).toEqual([
    "slot[0] (unoccupied ×1; skipped)",
    "slot[1] \"5\" = item[0] slot[2] = 9, slots[0..1] (unoccupied ×2; skipped), slot[3] (unoccupied ×1; skipped)",
    "slots[2..3] (unoccupied ×2; skipped)",
  ]);
});

const LINKED_LIST_SOURCE = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { LinkedList<uint64, 8> values; }; INITIALIZE() {} };`;

const linkedListState = () => {
  const bytes = new Uint8Array(240);
  bytes[192] = (1 << 1) | (1 << 2) | (1 << 6);
  bytes.set(le(6, 8), 200); // head
  bytes.set(le(2, 8), 208); // tail
  bytes.set(le(3, 8), 232); // population

  bytes.set(le(11, 8), 24);
  bytes.set(le(2, 8), 32);
  bytes.set(le(6, 8), 40);

  bytes.set(le(22, 8), 48);
  bytes.set(le(-1, 8), 56);
  bytes.set(le(1, 8), 64);

  bytes.set(le(66, 8), 144);
  bytes.set(le(1, 8), 152);
  bytes.set(le(-1, 8), 160);
  return bytes;
};

test("readState: an empty LinkedList only reads population", async () => {
  const calls: StateReadCall[] = [];
  const state = await readState(
    fakeRpc(new Uint8Array(240), calls),
    10,
    LINKED_LIST_SOURCE,
    "EmptyList",
  );

  expect(calls).toEqual([{ slot: 10, off: 232, len: 8 }]);
  expect(state.complete).toBe(true);
  expect(state.containers).toEqual([
    {
      name: "values",
      kind: "linkedlist",
      capacity: 8,
      occupiedSlots: 0,
      totalEntries: 0,
      entries: ["slots[0..7] (unoccupied ×8; skipped)"],
    },
  ]);
});

test("readState: LinkedList reads occupied nodes and renders logical order", async () => {
  const calls: StateReadCall[] = [];
  const state = await readState(
    fakeRpc(linkedListState(), calls),
    11,
    LINKED_LIST_SOURCE,
    "SparseList",
  );

  expect(calls).toEqual([
    { slot: 11, off: 232, len: 8 },
    { slot: 11, off: 192, len: 8 },
    { slot: 11, off: 200, len: 16 },
    { slot: 11, off: 24, len: 48 },
    { slot: 11, off: 144, len: 24 },
  ]);
  expect(state.complete).toBe(true);
  expect(state.containers).toEqual([
    {
      name: "values",
      kind: "linkedlist",
      capacity: 8,
      occupiedSlots: 3,
      totalEntries: 3,
      entries: [
        "item[0] slot[6] = 66",
        "item[1] slot[1] = 11",
        "item[2] slot[2] = 22",
        "slot[0] (unoccupied ×1; skipped)",
        "slots[3..5] (unoccupied ×3; skipped)",
        "slot[7] (unoccupied ×1; skipped)",
      ],
    },
  ]);
});

test("readState: LinkedList retries a transient topology change", async () => {
  const bytes = new Uint8Array(240);
  bytes[192] = 1;
  bytes.set(le(0, 8), 200);
  bytes.set(le(0, 8), 208);
  bytes.set(le(9, 8), 0);
  bytes.set(le(-1, 8), 8);
  bytes.set(le(-1, 8), 16);
  bytes.set(le(1, 8), 232);
  const calls: StateReadCall[] = [];
  let flagReads = 0;
  const rpc: StateReader = {
    stateRead: async (slot, off, len) => {
      calls.push({ slot, off, len });
      if (off === 192 && flagReads++ === 0) {
        return { hex: hx([3, 0, 0, 0, 0, 0, 0, 0]) };
      }
      return { hex: hx(Array.from(bytes.subarray(off, off + len))) };
    },
  };

  const state = await readState(rpc, 12, LINKED_LIST_SOURCE, "ChangingList");

  expect(state.complete).toBe(true);
  expect(calls.slice(0, 4)).toEqual([
    { slot: 12, off: 232, len: 8 },
    { slot: 12, off: 192, len: 8 },
    { slot: 12, off: 232, len: 8 },
    { slot: 12, off: 192, len: 8 },
  ]);
  expect(state.containers[0].entries[0]).toBe("item[0] slot[0] = 9");
});

test("readState: persistent LinkedList topology changes are incomplete", async () => {
  const bytes = new Uint8Array(240);
  bytes[192] = 3;
  bytes.set(le(1, 8), 232);
  const calls: StateReadCall[] = [];

  const state = await readState(
    fakeRpc(bytes, calls),
    13,
    LINKED_LIST_SOURCE,
    "BrokenList",
  );

  expect(calls).toEqual([
    { slot: 13, off: 232, len: 8 },
    { slot: 13, off: 192, len: 8 },
    { slot: 13, off: 232, len: 8 },
    { slot: 13, off: 192, len: 8 },
  ]);
  expect(state.complete).toBe(false);
  expect(state.containers[0].error).toContain("population changed");
});

test("readState: a sparse Collection fetches occupied PoVs and live elements", async () => {
  const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { Collection<uint64, 4> values; }; INITIALIZE() {} };`;
  const bytes = new Uint8Array(472);
  bytes.set(le(1, 8), 160); // PoV 2 population
  bytes.set(le(0, 8), 184); // PoV 2 root -> element 0
  bytes.set(le(1n << 4n, 8), 256); // PoV 2 occupied
  bytes.set(le(7, 8), 264); // element 0 value
  bytes.set(le(3, 8), 272); // priority
  bytes.set(le(2, 8), 280); // PoV index
  bytes.set(le(-1, 8), 288); // parent
  bytes.set(le(-1, 8), 296); // left
  bytes.set(le(-1, 8), 304); // right
  bytes.set(le(1, 8), 456); // total population
  const calls: StateReadCall[] = [];

  const state = await readState(
    fakeRpc(bytes, calls),
    5,
    source,
    "SparseCollection",
  );

  expect(calls).toEqual([
    { slot: 5, off: 456, len: 8 },
    { slot: 5, off: 256, len: 8 },
    { slot: 5, off: 128, len: 64 },
    { slot: 5, off: 264, len: 48 },
  ]);
  expect(state.complete).toBe(true);
  expect(state.containers[0]).toMatchObject({
    name: "values",
    kind: "collection",
    capacity: 4,
    occupiedSlots: 1,
    totalEntries: 1,
  });
  expect(state.containers[0].entries).toHaveLength(3);
  expect(state.containers[0].entries[1]).toContain(": 7 (p3)");
});

// signed i64 LE (for collection BST indices)
const i64 = (n: number | bigint) => {
  let v = BigInt.asUintN(64, BigInt(n));
  const b: number[] = [];
  for (let i = 0; i < 8; i++) {
    b.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return b;
};
const mkEntry = (o: Partial<any>): any => ({
  seq: 1,
  tick: 1,
  index: 0,
  entry: 1,
  kind: 1,
  ok: true,
  execNs: 0,
  invocator: "11".repeat(32),
  invocationReward: 0,
  inHex: "",
  outHex: "",
  stateDiff: [],
  hostCalls: [],
  logs: [],
  ...o,
});

test("describeTrace: multi-field input decodes to a tuple", async () => {
  const SRC_MULTI = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct Pair_input { uint64 a; uint64 b; }; struct Pair_output {}; PUBLIC_PROCEDURE(Pair) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Pair, 1); } INITIALIZE() {} };`;
  const v = await describeTrace(
    mkEntry({ inHex: hx([...le(5, 8), ...le(7, 8)]) }),
    SRC_MULTI,
    "M",
    fakeRpc([]),
  );
  expect(v.inDecoded).toBe('["5","7"]');
});

test("describeTrace: Collection state field is decoded into containers (priority order)", async () => {
  const SRC_COLL = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { Collection<uint64, 4> q; }; struct Add_input { id pov; uint64 v; sint64 p; }; struct Add_output {}; PUBLIC_PROCEDURE(Add) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Add, 1); } INITIALIZE() {} };`;
  const cap = 4,
    elemsOff = cap * 64 + 8;
  const b = new Array(elemsOff + cap * 48 + 16).fill(0);
  i64(0).forEach((x, i) => (b[56 + i] = x)); // PoV0.bstRoot = elem0
  b[cap * 64] = 1; // PoV0 occupied
  i64(7).forEach((x, i) => (b[elemsOff + i] = x)); // elem0 value=7
  i64(3).forEach((x, i) => (b[elemsOff + 8 + i] = x)); // priority=3
  i64(-1).forEach((x, i) => (b[elemsOff + 32 + i] = x));
  i64(-1).forEach((x, i) => (b[elemsOff + 40 + i] = x)); // no children
  const v = await describeTrace(mkEntry({ index: 1 }), SRC_COLL, "Coll", fakeRpc(b));
  expect(v.containers[0].name).toBe("q");
  expect(v.containers[0].entries[0]).toContain("7");
  expect(v.containers[0].entries[0]).toContain("p3");
});

test("describeTrace: HashSet state field is decoded into containers", async () => {
  const SRC_SET = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashSet<id, 4> seen; }; struct Mark_input { id who; }; struct Mark_output {}; PUBLIC_PROCEDURE(Mark) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Mark, 1); } INITIALIZE() {} };`;
  const b = new Array(4 * 32 + 8 + 16).fill(0);
  b[4 * 32] = 1; // slot0 (all-zero id) occupied
  const v = await describeTrace(mkEntry({ index: 2 }), SRC_SET, "Set", fakeRpc(b));
  expect(v.containers[0].name).toBe("seen");
  expect(v.containers[0].entries).toHaveLength(1);
});

test("describeTrace: LinkedList stays compact and follows logical order", async () => {
  const v = await describeTrace(
    mkEntry({ index: 14 }),
    LINKED_LIST_SOURCE,
    "ListTrace",
    fakeRpc(linkedListState()),
  );

  expect(v.containers).toEqual([
    {
      name: "values",
      entries: [
        "item[0] slot[6] = 66",
        "item[1] slot[1] = 11",
        "item[2] slot[2] = 22",
      ],
    },
  ]);
});

test("describeTrace: no StateData -> empty fields/containers, io still decoded, fn caller (none)", async () => {
  const SRC_NS = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct Foo_input { uint64 a; }; struct Foo_output { uint64 r; }; PUBLIC_FUNCTION(Foo) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Foo, 1); } INITIALIZE() {} };`;
  const v = await describeTrace(
    mkEntry({ kind: 0, inHex: hx(le(5, 8)), outHex: hx(le(9, 8)) }),
    SRC_NS,
    "NS",
    fakeRpc([]),
  );
  expect(v.fields).toHaveLength(0);
  expect(v.containers).toHaveLength(0);
  expect(v.inDecoded).toBe('"5"');
  expect(v.outDecoded).toBe('"9"');
  expect(v.caller).toBe("(none)"); // kind 0 (fn) carries no signer
});

test("fmtDiffVal: integer fields render the LE byte-run as decimal; ids/bytes stay hex", () => {
  const fields: StateField[] = [
    { name: "counter", off: 0, size: 8, type: "uint64" },
    { name: "owner", off: 8, size: 32, type: "id" },
  ];
  expect(fmtDiffVal(fields, 0, "64")).toBe("100"); // 0x64 LE -> 100 (the reported bug)
  expect(fmtDiffVal(fields, 0, "00")).toBe("0");
  expect(fmtDiffVal(fields, 0, "2c01")).toBe("300"); // multi-byte LE
  expect(fmtDiffVal(fields, 8, "ab12")).toBe("ab12"); // id field -> hex passthrough
  expect(fmtDiffVal(fields, 99, "64")).toBe("64"); // unknown offset -> hex (no field type)
});

test("describeTrace stays compact while readState reports incomplete reads", async () => {
  const boom: StateReader = {
    stateRead: async () => {
      throw new Error("rpc down");
    },
  };
  const v = await describeTrace(mkEntry({ index: 7 }), SRC, "Counter", boom);
  expect(v.containers).toHaveLength(0); // readStateContainers swallowed the error
  const state = await readState(boom, 7, SRC, "Counter");
  expect(state.complete).toBe(false);
  expect(state.fields).toEqual([
    { name: "counter", value: "(read failed: rpc down)" },
  ]);
  expect(state.containers).toEqual([
    {
      name: "bal",
      kind: "hashmap",
      capacity: 4,
      occupiedSlots: 0,
      totalEntries: 0,
      entries: [],
      error: "rpc down",
    },
  ]);
});

import { fmtVal } from "../../src/trace/format";
test("fmtVal: run-length-group long runs, keep short literal, cap unless full", () => {
  expect(fmtVal([0, 0, 0])).toBe("[0, 0, 0]"); // short run kept literal
  expect(fmtVal(Array(100).fill(0))).toBe("[0 ×100]"); // long run collapsed
  expect(fmtVal([1, 2, 2, 2, 2, 2, 2, 3])).toBe("[1, 2 ×6, 3]"); // run >= 6 collapsed, rest literal
  expect(fmtVal([5n, 7n])).toBe("[5, 7]"); // bigint
  const varied = Array.from({ length: 50 }, (_, i) => i);
  expect(fmtVal(varied)).toContain("+18 more (--all)"); // 50 -> cap 32 + 18 more
  expect(fmtVal(varied, true)).not.toContain("more"); // full -> all 50
  expect(
    fmtVal([
      ["A", "0"],
      ["A", "0"],
      ["A", "0"],
      ["A", "0"],
      ["A", "0"],
      ["A", "0"],
    ]),
  ).toBe(`[["A", "0"] ×6]`); // nested struct run
});
