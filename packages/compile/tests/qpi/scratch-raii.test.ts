import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 normalA; uint64 normalB;
    uint64 continueA; uint64 continueB;
    uint64 breakA; uint64 breakB;
    uint64 gotoA; uint64 gotoB;
    uint64 returnA; uint64 returnB;
    uint64 pointerValue;
  };
  struct Exercise_input {}; struct Exercise_output {};

  static void earlyReturn(uint64& address) {
    __ScopedScratchpad scratch(32, true);
    address = (uint64)scratch.ptr;
    return;
  }

  PUBLIC_PROCEDURE(Exercise) {
    {
      __ScopedScratchpad scratch(32, true);
      state.mut().normalA = (uint64)scratch.ptr;
      auto* words = reinterpret_cast<uint64*>(scratch.ptr);
      words[1] = 77;
      state.mut().pointerValue = words[1];
    }
    {
      __ScopedScratchpad scratch(32, true);
      state.mut().normalB = (uint64)scratch.ptr;
    }

    for (uint64 i = 0; i < 2; i++) {
      __ScopedScratchpad scratch(32, true);
      if (i == 0) state.mut().continueA = (uint64)scratch.ptr;
      else state.mut().continueB = (uint64)scratch.ptr;
      continue;
    }

    for (uint64 i = 0; i < 1; i++) {
      __ScopedScratchpad scratch(32, true);
      state.mut().breakA = (uint64)scratch.ptr;
      break;
    }
    {
      __ScopedScratchpad scratch(32, true);
      state.mut().breakB = (uint64)scratch.ptr;
    }

    {
      __ScopedScratchpad scratch(32, true);
      state.mut().gotoA = (uint64)scratch.ptr;
      goto afterScratch;
    }
afterScratch:
    {
      __ScopedScratchpad scratch(32, true);
      state.mut().gotoB = (uint64)scratch.ptr;
    }

    earlyReturn(state.mut().returnA);
    earlyReturn(state.mut().returnB);
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Exercise, 1); }
};`;

describe("scratchpad RAII and pointer lowering", () => {
  let state: BigUint64Array;

  beforeAll(async () => {
    await initK12();
    const result = await compileContract({
      source: SOURCE,
      name: "ScratchRaii",
      slot: 27,
      arenaSz: 1 << 20,
      qpiHeader: loadQpiHeader(CORE),
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(9);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, result.wasm);
    sim.procedure(27, 1, new Uint8Array(0), { invocator: user });
    const bytes = sim.contracts.get(27)!.state();
    state = new BigUint64Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  });

  test("normal scope, continue, break, goto, and return restore the same bump mark", () => {
    expect(state[0]).toBe(state[1]);
    expect(state[2]).toBe(state[3]);
    expect(state[4]).toBe(state[5]);
    expect(state[6]).toBe(state[7]);
    expect(state[8]).toBe(state[9]);
  });

  test("scratch.ptr casts preserve pointer scaling and dereference", () => {
    expect(state[10]).toBe(77n);
  });
});
