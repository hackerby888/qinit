import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src";

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Read_input {};
  struct Read_output { sint64 reward; id invocator; id originator; };
  PUBLIC_PROCEDURE(Read) {
    output.reward = qpi.invocationReward();
    output.invocator = qpi.invocator();
    output.originator = qpi.originator();
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Read, 1); }
};`;

describe("source-backed QPI context accessors", () => {
  beforeAll(initK12);

  test("reads reward, invocator, and originator from the entry context", async () => {
    const result = await compileContract({
      source: SOURCE,
      name: "ContextAccessors",
      slot: 27,
      qpiHeader: loadQpiHeader(CORE_PATH),
      arenaSz: 1 << 20,
    });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    const invocator = new Uint8Array(32).map((_, index) => index + 1);
    const originator = new Uint8Array(32).map((_, index) => 255 - index);
    const output =
      sim.deploy(27, result.wasm) &&
      sim.procedure(27, 1, undefined, {
        invocator,
        originator,
        reward: 123456789n,
      });

    expect(
      new DataView(output.buffer, output.byteOffset, output.byteLength).getBigInt64(0, true),
    ).toBe(123456789n);
    expect(output.slice(8, 40)).toEqual(invocator);
    expect(output.slice(40, 72)).toEqual(originator);
  });
});
