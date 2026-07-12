import { CORE_PATH } from "../../../../test-utils/paths";
// Function-call boundaries perform implicit conversions in native C++. Keeping the caller's
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const wrap = (helper: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; uint64 denominator; uint64 adjacent; };
  ${helper}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function run(helper: string, body: string): Promise<bigint> {
  const result = await compileContract({
    source: wrap(helper, body),
    name: "ParamConversionEdge",
    slot: 27,
    qpiHeader: HEADERS,
    arenaSz: 1 << 20,
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  expect(WebAssembly.validate(result.wasm)).toBe(true);

  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, result.wasm);
  sim.procedure(27, 1, undefined, { invocator: user });
  const state = sim.contracts.get(27)!.state();
  return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

describe("edge audit — implicit parameter conversions", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("a uint8 value parameter narrows the argument modulo 256", async () => {
    expect(await run(`static uint64 cv(uint8 value) { return value; }`, `state.mut().result = cv(300);`)).toBe(44n);
  });

  test("a sint8 value parameter narrows and sign-extends the argument", async () => {
    expect(await run(`static sint64 cv(sint8 value) { return value; }`, `state.mut().result = (uint64)cv(255);`)).toBe(0xffff_ffff_ffff_ffffn);
  });

  test("a uint16 value parameter narrows the argument modulo 65536", async () => {
    expect(await run(`static uint64 cv(uint16 value) { return value; }`, `state.mut().result = cv(65537);`)).toBe(1n);
  });

  test("a bool value parameter canonicalizes a nonzero argument", async () => {
    expect(await run(`static uint64 cv(bool value) { return value ? 1 : 0; }`, `state.mut().result = cv(2);`)).toBe(1n);
  });

  test("a default argument is converted to its declared uint8 parameter type", async () => {
    expect(await run(`static uint64 cv(uint8 value = 300) { return value; }`, `state.mut().result = cv();`)).toBe(44n);
  });

  test("a const uint8 reference binds to a converted temporary", async () => {
    expect(await run(`static uint64 cv(const uint8& value) { return value; }`, `state.mut().result = cv(300);`)).toBe(44n);
  });

  test("a scalar state field binds to a converted temporary for a const uint128 reference", async () => {
    expect(await run(
      ``,
      `state.mut().denominator = 2; state.mut().adjacent = 1;
       uint128 numerator = (uint128)84;
       state.mut().result = div<uint128>(numerator, state.get().denominator).low;`,
    )).toBe(42n);
  });

  test("a widened product divides by a scalar state field through a const uint128 reference", async () => {
    expect(await run(
      ``,
      `state.mut().denominator = 1000000; state.mut().adjacent = 450000;
       uint128 numerator = (uint128)150000 * (uint128)state.get().adjacent;
       state.mut().result = div<uint128>(numerator, state.get().denominator).low;`,
    )).toBe(67500n);
  });
});
