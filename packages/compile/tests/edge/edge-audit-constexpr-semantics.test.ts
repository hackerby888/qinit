import { CORE_PATH } from "../../../../test-utils/paths";
// Named constexpr expressions retain their declared C++ width/signedness; user contract members also shadow same-named constants imported from qpi.h.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const wrap = (constant: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${constant}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function run(source: string): Promise<bigint> {
  const result = await compileContract({
    source,
    name: "ConstexprEdge",
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
  return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

describe("edge audit — typed constexpr semantics", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("uint32 constexpr arithmetic wraps at 32 bits", async () => {
    const source = wrap(
      `static constexpr uint32 EDGE_WRAP_K = 4294967295u;`,
      `state.mut().result = EDGE_WRAP_K + 1u;`,
    );
    expect(await run(source)).toBe(0n);
  });

  test("constexpr narrowing cast is applied", async () => {
    const source = wrap(
      `static constexpr uint8 EDGE_NARROW_K = (uint8)300;`,
      `state.mut().result = EDGE_NARROW_K;`,
    );
    expect(await run(source)).toBe(44n);
  });

  test("uint64 constexpr comparison uses unsigned ordering", async () => {
    const source = wrap(
      `static constexpr uint64 EDGE_HIGH_K = 0x8000000000000000ull;`,
      `state.mut().result = EDGE_HIGH_K > 1 ? 1 : 0;`,
    );
    expect(await run(source)).toBe(1n);
  });

  test("contract member constant shadows same-named qpi.h constant", async () => {
    // qpi.h currently contributes an unrelated K; class scope must still resolve this member first.
    const source = wrap(`static constexpr uint64 K = 123;`, `state.mut().result = K;`);
    expect(await run(source)).toBe(123n);
  });
});
