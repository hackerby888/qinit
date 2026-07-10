// Direct initialization is common in QPI/C++ helper bodies. The parser currently consumes braced
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

async function compile(source: string) {
  return compileContract({
    source,
    name: "InitEdge",
    slot: 27,
    qpiHeader: HEADERS,
    arenaSz: 1 << 20,
  });
}

async function run(source: string): Promise<bigint> {
  const result = await compile(source);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, result.wasm);
  sim.procedure(27, 1, undefined, { invocator: user });
  const state = sim.contracts.get(27)!.state();
  return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

describe("edge audit — direct and aggregate initialization", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("scalar direct-list initialization preserves its value", async () => {
    expect(await run(wrap("", `uint64 value{7}; state.mut().result = value;`))).toBe(7n);
  });

  test("scalar direct-parenthesized initialization preserves its value", async () => {
    expect(await run(wrap("", `uint64 value(7); state.mut().result = value;`))).toBe(7n);
  });

  test("aggregate direct-list initialization stores every field", async () => {
    const source = wrap(
      `struct Pair { uint64 left; uint64 right; };`,
      `Pair pair{7, 9}; state.mut().result = pair.left + pair.right;`,
    );
    expect(await run(source)).toBe(16n);
  });

  test("aggregate copy-list initialization remains supported", async () => {
    const source = wrap(
      `struct Pair { uint64 left; uint64 right; };`,
      `Pair pair = {7, 9}; state.mut().result = pair.left + pair.right;`,
    );
    expect(await run(source)).toBe(16n);
  });

  test("too many aggregate initializers are rejected", async () => {
    const source = wrap(
      `struct Pair { uint64 left; uint64 right; };`,
      `Pair pair = {7, 9, 11}; state.mut().result = pair.left + pair.right;`,
    );
    const result = await compile(source);
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.some((d) => /initializer|too many|field/i.test(d.message))).toBe(true);
    expect(result.wasm).toHaveLength(0);
  });
});
