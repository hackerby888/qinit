// Fixed C arrays occur in QPI ABI/state layouts. Cover initialization cardinality, inferred bounds,
// multidimensional addressing, and zero-initialization of omitted elements.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader("/home/kali/Projects/core-lite");

const wrap = (stateFields: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; ${stateFields} };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function compile(source: string) {
  return compileContract({ source, name: "CArrayEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
}

async function run(stateFields: string, body: string): Promise<bigint> {
  const result = await compile(wrap(stateFields, body));
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

describe("edge audit — fixed C arrays", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("an exact local initializer populates every element", async () => {
    expect(await run("", `uint64 xs[2] = {7, 9}; state.mut().result = xs[0] + xs[1];`)).toBe(16n);
  });

  test("an omitted local bound is inferred from the initializer", async () => {
    expect(await run("", `uint64 xs[] = {7, 9}; state.mut().result = xs[0] + xs[1];`)).toBe(16n);
  });

  test("missing local initializers zero-fill the remaining elements", async () => {
    expect(await run("", `uint64 xs[3] = {7}; state.mut().result = xs[0] + xs[1] + xs[2];`)).toBe(7n);
  });

  test("multidimensional state arrays preserve row-major indexing", async () => {
    const body = `state.mut().grid[0][0] = 1; state.mut().grid[0][1] = 2;
      state.mut().grid[1][0] = 4; state.mut().grid[1][1] = 8;
      state.mut().result = state.get().grid[0][1] + state.get().grid[1][1];`;
    expect(await run(`uint64 grid[2][2];`, body)).toBe(10n);
  });

  test("nested initializer lists populate a multidimensional local array", async () => {
    expect(await run("", `uint64 xs[2][2] = {{1, 2}, {3, 4}}; state.mut().result = xs[0][1] + xs[1][1];`)).toBe(6n);
  });

  test("too many local array initializers are rejected", async () => {
    const result = await compile(wrap("", `uint64 xs[2] = {1, 2, 3}; state.mut().result = xs[0];`));
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    expect(errors.some((d) => /initializer|too many|array.*bound|array.*size/i.test(d.message))).toBe(true);
    expect(result.wasm).toHaveLength(0);
  });
});
