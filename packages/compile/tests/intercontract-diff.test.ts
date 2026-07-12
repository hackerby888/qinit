import { CORE_PATH } from "../../../test-utils/paths";
// Inter-contract calls compiled by @qinit/compile: a caller at a higher slot reaches a callee at a lower slot
import { describe, test, expect, beforeAll } from "bun:test";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader, type CompileResult } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const COUNTER = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; };
  struct Inc_input {}; struct Inc_output {};
  struct Get_input {}; struct Get_output { uint64 value; };
  PUBLIC_PROCEDURE(Inc) { state.mut().counter += 1; }
  PUBLIC_FUNCTION(Get) { output.value = state.get().counter; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Inc, 1); REGISTER_USER_FUNCTION(Get, 1); }
};`;

// Caller declares its own in/out structs (same byte layout as Counter's) for the call buffers — it never
const CALLER = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 dummy; };
  struct GetIn {}; struct GetOut { uint64 value; };
  struct IncIn {}; struct IncOut {};
  struct ReadCounter_input {}; struct ReadCounter_output { uint64 value; };
  struct ReadCounter_locals { GetIn gi; GetOut go; };
  struct BumpCounter_input {}; struct BumpCounter_output {};
  struct BumpCounter_locals { IncIn ii; IncOut io; };
  PUBLIC_FUNCTION_WITH_LOCALS(ReadCounter) {
    CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);
    output.value = locals.go.value;
  }
  PUBLIC_PROCEDURE_WITH_LOCALS(BumpCounter) {
    INVOKE_OTHER_CONTRACT_PROCEDURE(Counter, Inc, locals.ii, locals.io, 0);
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(ReadCounter, 1); REGISTER_USER_PROCEDURE(BumpCounter, 1); }
};`;

function calleeIdlFrom(name: string, index: number, r: CompileResult) {
  const fns = Object.fromEntries(r.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }]));
  const procs = Object.fromEntries(r.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }]));
  return { name, index, functions: fns, procedures: procs };
}

function u64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
}

describe("inter-contract — Caller(29) → Counter(28) via CALL/INVOKE_OTHER", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("CALL_OTHER reads the callee, INVOKE_OTHER mutates it across the boundary", async () => {
    const counter = await compileContract({ source: COUNTER, name: "Counter", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(counter.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const callees = [calleeIdlFrom("Counter", 28, counter)];
    const caller = await compileContract({ source: CALLER, name: "Caller", slot: 29, qpiHeader: HEADERS, arenaSz: 1024 * 1024, callees });
    expect(caller.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(28, counter.wasm);
    sim.deploy(29, caller.wasm);

    // Caller.ReadCounter (fn 1) → Counter.Get; both start at 0.
    expect(u64(sim.query(29, 1))).toBe(0n);
    expect(u64(sim.query(28, 1))).toBe(0n);

    // Caller.BumpCounter (proc 1) → Counter.Inc.
    sim.procedure(29, 1);
    expect(u64(sim.query(28, 1))).toBe(1n);   // Counter incremented through the caller
    expect(u64(sim.query(29, 1))).toBe(1n);   // caller reads Counter == 1 via CALL_OTHER

    sim.procedure(29, 1);
    expect(u64(sim.query(28, 1))).toBe(2n);
    expect(u64(sim.query(29, 1))).toBe(2n);
  });
});
