import { test, expect } from "bun:test";
import { describeTrace, readState, type StateReader } from "./trace-format";

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
