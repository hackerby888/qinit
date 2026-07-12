import { CORE_PATH } from "../../../test-utils/paths";
// Valid expression forms that currently fail strict compilation. These tests pin both
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function compileAndRun(source: string): Promise<bigint> {
  const result = await compileContract({
    source,
    name: "ExpressionEdge",
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

describe("edge audit — valid expression lowering", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("sizeof(postfix expression) uses the operand type without evaluating it", async () => {
    const source = wrap("", `
      uint32 value = 5;
      uint64 size = sizeof(value++);
      state.mut().result = size + value * 10;
    `);
    expect(await compileAndRun(source)).toBe(54n);
  });

  test("sizeof(arithmetic expression) uses the promoted result type", async () => {
    const source = wrap("", `
      uint16 value = 5;
      state.mut().result = sizeof(value + 1);
    `);
    expect(await compileAndRun(source)).toBe(4n);
  });

  test("member access on an aggregate return temporary", async () => {
    const source = wrap(
      `struct Pair { uint64 value; };
       static Pair make() { Pair p{}; p.value = 9; return p; }`,
      `state.mut().result = make().value;`,
    );
    expect(await compileAndRun(source)).toBe(9n);
  });
});
