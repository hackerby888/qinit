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
