import { CORE_PATH } from "../../../../test-utils/paths";
// Enum storage width and signedness come from the declared underlying type, including when the enum is held in
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const wrap = (enumDecl: string, stateExtra: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${enumDecl}
  struct StateData { uint64 result; ${stateExtra} };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function run(source: string): Promise<{ value: bigint; stateSize: number }> {
  const result = await compileContract({
    source,
    name: "EnumEdge",
    slot: 27,
    qpiHeader: HEADERS,
    arenaSz: 1 << 20,
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, result.wasm);
  sim.procedure(27, 1, undefined, { invocator: user });
  const state = sim.contracts.get(27)!.state();
  return {
    value: new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true),
    stateSize: state.byteLength,
  };
}

describe("edge audit — enum underlying types", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("uint64-backed enum comparison is unsigned", async () => {
    const source = wrap(
      `enum class E : uint64 { Low = 1, High = 0x8000000000000000ull };`,
      "",
      `E value = E::High; state.mut().result = value > E::Low ? 1 : 0;`,
    );
    expect((await run(source)).value).toBe(1n);
  });

  test("signed narrow enum field sign-extends when loaded", async () => {
    const source = wrap(
      `enum class E : sint8 { Negative = -1, Zero = 0 };`,
      `E stored;`,
      `state.mut().stored = E::Negative;
       state.mut().result = state.get().stored == E::Negative ? 1 : 0;`,
    );
    expect((await run(source)).value).toBe(1n);
  });

  test("explicit enum width participates in struct layout", async () => {
    const source = wrap(
      `enum class E : uint8 { Zero = 0, One = 1 };`,
      `E stored; uint32 tail;`,
      `state.mut().stored = E::One; state.mut().tail = 9; state.mut().result = 1;`,
    );
    // result@0 (8), stored@8 (1), padding, tail@12 (4) => 16.
    expect((await run(source)).stateSize).toBe(16);
  });

  test("implicit enumerator values advance after explicit values", async () => {
    const source = wrap(`enum E { A = 4, B, C = 9, D };`, "", `state.mut().result = B * 100 + D;`);
    expect((await run(source)).value).toBe(510n);
  });
});
