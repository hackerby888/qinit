// `auto` must preserve the initializer's C++ type. Treating every deduced scalar as uint64 delays
// wrapping and changes comparisons, increments, and later arithmetic.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader("/home/kali/Projects/core-lite");

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function run(members: string, body: string): Promise<bigint> {
  const result = await compileContract({ source: wrap(members, body), name: "AutoEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, result.wasm);
  sim.procedure(27, 1, undefined, { invocator: user });
  const state = sim.contracts.get(27)!.state();
  return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

describe("edge audit — auto type deduction", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("auto deduced from uint32 retains 32-bit arithmetic", async () => {
    expect(await run("", `uint32 source = 4294967295u; auto value = source; state.mut().result = value + 1u;`)).toBe(0n);
  });

  test("auto deduced from a uint32 helper return retains 32-bit arithmetic", async () => {
    expect(await run(`static uint32 source() { return 4294967295u; }`, `auto value = source(); state.mut().result = value + 1u;`)).toBe(0n);
  });

  test("auto deduced from uint16 wraps on postfix increment", async () => {
    expect(await run("", `uint16 source = 65535; auto value = source; value++; state.mut().result = value;`)).toBe(0n);
  });

  test("auto deduced from sint8 preserves signed comparisons", async () => {
    expect(await run("", `sint8 source = -1; auto value = source; state.mut().result = value < 0 ? 1 : 0;`)).toBe(1n);
  });

  test("auto deduced from an explicit uint32 cast retains the cast type", async () => {
    expect(await run("", `auto value = (uint32)4294967295u; state.mut().result = value + 1u;`)).toBe(0n);
  });
});
