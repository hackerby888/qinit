import { test, expect } from "bun:test";
import { describeTrace, readState, fmtDiffVal, type StateReader, type StateField } from "../../src/trace-format";

// LE bytes / hex helpers
const le = (n: bigint | number, w: number) => { let v = BigInt.asUintN(64, BigInt(n)); const b: number[] = []; for (let i = 0; i < w; i++) { b.push(Number(v & 0xffn)); v >>= 8n; } return b; };
const hx = (b: number[]) => b.map((x) => (x & 0xff).toString(16).padStart(2, "0")).join("");
// HashMap<id,uint64,4> with slot0 -> value (key = all-zero id): element stride 40, value@32, flags@160
const hashmapBuf = (value: number) => { const buf = new Array(176).fill(0); le(value, 8).forEach((x, i) => (buf[32 + i] = x)); buf[160] = 1; return hx(buf); };

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

// counter is uint64 @0; bal (HashMap) @8. Fake state-read keys on the requested offset.
const fakeRpc = (bufs: Record<number, string>): StateReader => ({ stateRead: async (_s, off) => ({ hex: bufs[off] ?? "" }) });

test("describeTrace: decodes proc input, caller, log _type enum name, and container contents", async () => {
  const entry: any = {
    seq: 1, tick: 10, index: 7, entry: 1, kind: 1, ok: true, execNs: 1000,
    invocator: "11".repeat(32), invocationReward: 0,
    inHex: hx(le(5, 8)),                                   // by = 5
    outHex: "", stateDiff: [], hostCalls: [],
    logs: [{ type: 6, size: 16, hex: hx([...le(0, 4), ...le(1, 4), ...le(9, 8)]) }], // _type=1, value=9
  };
  const v = await describeTrace(entry, SRC, "Counter", fakeRpc({ 8: hashmapBuf(42) }));
  expect(v.inDecoded).toBe('"5"');                          // single-field input -> scalar (bigint as json string)
  expect(v.caller.length).toBe(60);                         // proc -> 60-char identity
  expect(v.logs).toHaveLength(1);
  expect(v.logs[0].typeName).toBe("Bumped");               // enum Kind: 1 -> Bumped
  expect(v.logs[0].fields).toEqual({ _contractIndex: 0, _type: 1, value: 9n });
  expect(v.cols).toHaveLength(1);
  expect(v.cols[0].name).toBe("bal");
  expect(v.cols[0].entries[0]).toContain("42");
});

test("describeTrace: no source -> raw hex passthrough, no decode", async () => {
  const entry: any = { seq: 2, tick: 1, index: 0, entry: 1, kind: 0, ok: true, execNs: 0, invocator: "0".repeat(64), invocationReward: 0, inHex: "abcd", outHex: "", stateDiff: [], hostCalls: [], logs: [] };
  const v = await describeTrace(entry, undefined, "X", fakeRpc({}));
  expect(v.inDecoded).toBe("0xabcd");
  expect(v.caller).toBe("(none)");
  expect(v.cols).toHaveLength(0);
});

test("readState: scalar fields decoded + container entries", async () => {
  const dump = await readState(fakeRpc({ 0: hx(le(7, 8)), 8: hashmapBuf(42) }), 7, SRC, "Counter");
  expect(dump.fields).toEqual([{ name: "counter", value: "7" }]);   // bal is a container -> not a scalar
  expect(dump.cols).toHaveLength(1);
  expect(dump.cols[0].name).toBe("bal");
  expect(dump.cols[0].entries[0]).toContain("42");
});

// signed i64 LE (for collection BST indices)
const i64 = (n: number | bigint) => { let v = BigInt.asUintN(64, BigInt(n)); const b: number[] = []; for (let i = 0; i < 8; i++) { b.push(Number(v & 0xffn)); v >>= 8n; } return b; };
const mkEntry = (o: Partial<any>): any => ({ seq: 1, tick: 1, index: 0, entry: 1, kind: 1, ok: true, execNs: 0, invocator: "11".repeat(32), invocationReward: 0, inHex: "", outHex: "", stateDiff: [], hostCalls: [], logs: [], ...o });

test("describeTrace: multi-field input decodes to a tuple", async () => {
  const SRC_MULTI = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct Pair_input { uint64 a; uint64 b; }; struct Pair_output {}; PUBLIC_PROCEDURE(Pair) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Pair, 1); } INITIALIZE() {} };`;
  const v = await describeTrace(mkEntry({ inHex: hx([...le(5, 8), ...le(7, 8)]) }), SRC_MULTI, "M", fakeRpc({}));
  expect(v.inDecoded).toBe('["5","7"]');
});

test("describeTrace: Collection state field is decoded into cols (priority order)", async () => {
  const SRC_COLL = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { Collection<uint64, 4> q; }; struct Add_input { id pov; uint64 v; sint64 p; }; struct Add_output {}; PUBLIC_PROCEDURE(Add) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Add, 1); } INITIALIZE() {} };`;
  const cap = 4, elemsOff = cap * 64 + 8;
  const b = new Array(elemsOff + cap * 48 + 16).fill(0);
  i64(0).forEach((x, i) => (b[56 + i] = x));          // PoV0.bstRoot = elem0
  b[cap * 64] = 1;                                     // PoV0 occupied
  i64(7).forEach((x, i) => (b[elemsOff + i] = x));     // elem0 value=7
  i64(3).forEach((x, i) => (b[elemsOff + 8 + i] = x)); // priority=3
  i64(-1).forEach((x, i) => (b[elemsOff + 32 + i] = x)); i64(-1).forEach((x, i) => (b[elemsOff + 40 + i] = x)); // no children
  const v = await describeTrace(mkEntry({ index: 1 }), SRC_COLL, "Coll", fakeRpc({ 0: hx(b) }));
  expect(v.cols[0].name).toBe("q");
  expect(v.cols[0].entries[0]).toContain("7");
  expect(v.cols[0].entries[0]).toContain("p3");
});

test("describeTrace: HashSet state field is decoded into cols", async () => {
  const SRC_SET = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashSet<id, 4> seen; }; struct Mark_input { id who; }; struct Mark_output {}; PUBLIC_PROCEDURE(Mark) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Mark, 1); } INITIALIZE() {} };`;
  const b = new Array(4 * 32 + 16).fill(0); b[4 * 32] = 1;       // slot0 (all-zero id) occupied
  const v = await describeTrace(mkEntry({ index: 2 }), SRC_SET, "Set", fakeRpc({ 0: hx(b) }));
  expect(v.cols[0].name).toBe("seen");
  expect(v.cols[0].entries).toHaveLength(1);
});

test("describeTrace: no StateData -> empty fields/cols, io still decoded, fn caller (none)", async () => {
  const SRC_NS = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct Foo_input { uint64 a; }; struct Foo_output { uint64 r; }; PUBLIC_FUNCTION(Foo) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Foo, 1); } INITIALIZE() {} };`;
  const v = await describeTrace(mkEntry({ kind: 0, inHex: hx(le(5, 8)), outHex: hx(le(9, 8)) }), SRC_NS, "NS", fakeRpc({}));
  expect(v.fields).toHaveLength(0);
  expect(v.cols).toHaveLength(0);
  expect(v.inDecoded).toBe('"5"');
  expect(v.outDecoded).toBe('"9"');
  expect(v.caller).toBe("(none)");                                // kind 0 (fn) carries no signer
});

test("fmtDiffVal: integer fields render the LE byte-run as decimal; ids/bytes stay hex", () => {
  const fields: StateField[] = [
    { name: "counter", off: 0, size: 8, type: "uint64" },
    { name: "owner", off: 8, size: 32, type: "id" },
  ];
  expect(fmtDiffVal(fields, 0, "64")).toBe("100");      // 0x64 LE -> 100 (the reported bug)
  expect(fmtDiffVal(fields, 0, "00")).toBe("0");
  expect(fmtDiffVal(fields, 0, "2c01")).toBe("300");    // multi-byte LE
  expect(fmtDiffVal(fields, 8, "ab12")).toBe("ab12");   // id field -> hex passthrough
  expect(fmtDiffVal(fields, 99, "64")).toBe("64");      // unknown offset -> hex (no field type)
});

test("describeTrace/readState: a stateRead failure degrades gracefully", async () => {
  const boom: StateReader = { stateRead: async () => { throw new Error("rpc down"); } };
  const v = await describeTrace(mkEntry({ index: 7 }), SRC, "Counter", boom);
  expect(v.cols).toHaveLength(0);                                 // decodeColumns swallowed the error
  const dump = await readState(boom, 7, SRC, "Counter");
  expect(dump.fields).toEqual([{ name: "counter", value: "(read failed)" }]);
  expect(dump.cols).toHaveLength(0);
});

import { fmtVal } from "../../src/trace-format";
test("fmtVal: run-length-group long runs, keep short literal, cap unless full", () => {
  expect(fmtVal([0, 0, 0])).toBe("[0, 0, 0]");                       // short run kept literal
  expect(fmtVal(Array(100).fill(0))).toBe("[0 ×100]");              // long run collapsed
  expect(fmtVal([1, 2, 2, 2, 2, 2, 2, 3])).toBe("[1, 2 ×6, 3]");    // run >= 6 collapsed, rest literal
  expect(fmtVal([5n, 7n])).toBe("[5, 7]");                          // bigint
  const varied = Array.from({ length: 50 }, (_, i) => i);
  expect(fmtVal(varied)).toContain("+18 more (--all)");             // 50 -> cap 32 + 18 more
  expect(fmtVal(varied, true)).not.toContain("more");              // full -> all 50
  expect(fmtVal([["A", "0"], ["A", "0"], ["A", "0"], ["A", "0"], ["A", "0"], ["A", "0"]])).toBe(`[["A", "0"] ×6]`);  // nested struct run
});
