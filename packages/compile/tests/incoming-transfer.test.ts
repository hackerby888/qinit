// POST_INCOMING_TRANSFER system procedure compiled by @qinit/compile: the engine fires it (nested,
// synchronous) whenever value lands on the contract, passing a PostIncomingTransfer_input { id sourceId;
// sint64 amount; uint8 type; }. This only works if the sysproc is emitted with bit 9 in reg_sysproc_mask
// AND sysproc_in_size(9) == sizeof(PostIncomingTransfer_input) so the host copies the notice bytes in.
// A reward-bearing procedure call (procedureTransaction, type 1) is the simplest trigger. Engine-driven.
import { describe, test, expect, beforeAll } from "bun:test";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const SINK = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 lastAmount; uint64 lastType; uint64 count; };
  struct Touch_input {}; struct Touch_output {};
  struct Get_input {}; struct Get_output { uint64 amount; uint64 type; uint64 count; };
  POST_INCOMING_TRANSFER() {
    state.mut().lastAmount = input.amount;
    state.mut().lastType = input.type;
    state.mut().count += 1;
  }
  PUBLIC_PROCEDURE(Touch) {}
  PUBLIC_FUNCTION(Get) {
    output.amount = state.get().lastAmount;
    output.type = state.get().lastType;
    output.count = state.get().count;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Touch, 1); REGISTER_USER_FUNCTION(Get, 1);
  }
};`;

function u64(b: Uint8Array, off = 0): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, true);
}

describe("sysproc — POST_INCOMING_TRANSFER receives the transfer notice", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("a reward-bearing procedure fires PIT with the right amount + type", async () => {
    const sink = await compileContract({ source: SINK, name: "Sink", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(sink.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(28, sink.wasm);

    // No transfer yet — PIT never fired.
    let g = sim.query(28, 1);
    expect(u64(g, 0)).toBe(0n);   // amount
    expect(u64(g, 8)).toBe(0n);   // type
    expect(u64(g, 16)).toBe(0n);  // count

    // Touch (proc 1) with a reward: engine credits the contract then fires PIT (procedureTransaction = 1)
    // before the Touch body runs.
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.procedure(28, 1, undefined, { reward: 500n, invocator: user });

    g = sim.query(28, 1);
    expect(u64(g, 0)).toBe(500n); // amount captured from input.amount
    expect(u64(g, 8)).toBe(1n);   // type == procedureTransaction
    expect(u64(g, 16)).toBe(1n);  // fired exactly once

    // A second reward-bearing call fires it again, accumulating count.
    sim.procedure(28, 1, undefined, { reward: 250n, invocator: user });
    g = sim.query(28, 1);
    expect(u64(g, 0)).toBe(250n);
    expect(u64(g, 8)).toBe(1n);
    expect(u64(g, 16)).toBe(2n);
  });
});
