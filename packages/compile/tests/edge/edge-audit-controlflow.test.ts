import { CORE_PATH } from "../../../../test-utils/paths";
// Missing positive coverage for QPI-legal control flow. Unlike the red regression files,
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  struct X_input {}; struct X_output {};
  typedef X_input ForContinue_input; typedef X_output ForContinue_output;
  typedef X_input WhileContinue_input; typedef X_output WhileContinue_output;
  typedef X_input DoContinue_input; typedef X_output DoContinue_output;
  typedef X_input NestedLoops_input; typedef X_output NestedLoops_output;
  typedef X_input DefaultInMiddle_input; typedef X_output DefaultInMiddle_output;
  typedef X_input DanglingElse_input; typedef X_output DanglingElse_output;
  typedef X_input ShortCircuit_input; typedef X_output ShortCircuit_output;
  typedef X_input SwitchSelectorOnce_input; typedef X_output SwitchSelectorOnce_output;

  PUBLIC_PROCEDURE(ForContinue) {
    uint64 i = 0, sum = 0;
    for (i = 0; i < 5; i++) { if (i == 2) continue; sum += i; }
    state.mut().result = sum;
  }
  PUBLIC_PROCEDURE(WhileContinue) {
    uint64 i = 0, sum = 0;
    while (i < 5) { i++; if (i == 3) continue; sum += i; }
    state.mut().result = sum;
  }
  PUBLIC_PROCEDURE(DoContinue) {
    uint64 i = 0, sum = 0;
    do { i++; if (i < 3) continue; sum += i; } while (i < 4);
    state.mut().result = sum;
  }
  PUBLIC_PROCEDURE(NestedLoops) {
    uint64 i = 0, j = 0, sum = 0;
    for (i = 0; i < 3; i++) {
      for (j = 0; j < 4; j++) {
        if (j == 1) continue;
        if (i == 2 && j == 3) break;
        sum += i * 10 + j;
      }
    }
    state.mut().result = sum;
  }
  PUBLIC_PROCEDURE(DefaultInMiddle) {
    uint64 matched = 0, missing = 0, x = 3, y = 2;
    switch (x) { case 1: matched = 10; break; default: matched = 20; case 3: matched += 3; break; }
    switch (y) { case 1: missing = 10; break; default: missing = 20; case 3: missing += 3; break; }
    state.mut().result = matched * 100 + missing;
  }
  PUBLIC_PROCEDURE(DanglingElse) {
    uint64 value = 0;
    if (true)
      if (false) value = 1;
      else value = 2;
    if (false) value = 4;
    else if (true) value += 3;
    state.mut().result = value;
  }
  PUBLIC_PROCEDURE(ShortCircuit) {
    uint64 left = 0, right = 0;
    if (false && (++left != 0)) left = 9;
    if (true || (++right != 0)) right += 0;
    state.mut().result = left * 10 + right;
  }
  PUBLIC_PROCEDURE(SwitchSelectorOnce) {
    uint64 selector = 2, selected = 0;
    switch (selector++) { case 2: selected = 7; break; default: selected = 9; }
    state.mut().result = selected * 10 + selector;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(ForContinue, 1);
    REGISTER_USER_PROCEDURE(WhileContinue, 2);
    REGISTER_USER_PROCEDURE(DoContinue, 3);
    REGISTER_USER_PROCEDURE(NestedLoops, 4);
    REGISTER_USER_PROCEDURE(DefaultInMiddle, 5);
    REGISTER_USER_PROCEDURE(DanglingElse, 6);
    REGISTER_USER_PROCEDURE(ShortCircuit, 7);
    REGISTER_USER_PROCEDURE(SwitchSelectorOnce, 8);
  }
};`;

let wasm: Uint8Array;

function run(inputType: number): bigint {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, wasm);
  sim.procedure(27, inputType, undefined, { invocator: user });
  const state = sim.contracts.get(27)!.state();
  return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

describe("edge audit — control-flow semantics", () => {
  beforeAll(async () => {
    await initK12();
    const result = await compileContract({
      source: SOURCE,
      name: "ControlEdge",
      slot: 27,
      qpiHeader: HEADERS,
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(WebAssembly.validate(result.wasm)).toBe(true);
    wasm = result.wasm;
  });

  test("for continue still performs the update expression", () => expect(run(1)).toBe(8n));
  test("while continue rechecks the condition", () => expect(run(2)).toBe(12n));
  test("do-while continue reaches the trailing condition", () => expect(run(3)).toBe(7n));
  test("nested break and continue target the nearest loop", () => expect(run(4)).toBe(82n));
  test("default in the middle supports direct later-case dispatch and fallthrough", () =>
    expect(run(5)).toBe(323n));
  test("dangling else binds to the nearest if", () => expect(run(6)).toBe(5n));
  test("logical operators short-circuit side effects", () => expect(run(7)).toBe(0n));
  test("switch selector with postfix increment is evaluated once", () => expect(run(8)).toBe(73n));
});
