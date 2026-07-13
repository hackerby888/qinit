import { CORE_PATH } from "../../../../test-utils/paths";
// These QPI-legal aggregate cases are positive controls around the red aggregate validation tests: copies, returned temporaries, const-reference binding,
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const wrap = (members: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  struct Pair { uint64 left; uint64 right; };
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function run(members: string, body: string): Promise<bigint> {
  const result = await compileContract({
    source: wrap(members, body),
    name: "AggregateRuntimeEdge",
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

describe("edge audit — aggregate runtime semantics", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("mutating a by-value aggregate parameter does not mutate the caller", async () => {
    const helper = `static Pair changed(Pair value) { value.left = 9; return value; }`;
    const body = `Pair original = {1, 2}; Pair copy = changed(original); state.mut().result = copy.left * 10 + original.left;`;
    expect(await run(helper, body)).toBe(91n);
  });

  test("two aggregate return values use independent storage", async () => {
    const helper = `static Pair make(uint64 left, uint64 right) { Pair value = {left, right}; return value; }`;
    const body = `Pair first = make(1, 2); Pair second = make(3, 4); state.mut().result = first.left * 10 + second.left;`;
    expect(await run(helper, body)).toBe(13n);
  });

  test("a returned aggregate preserves nested aggregate fields", async () => {
    const helper = `struct Outer { Pair pair; uint64 extra; };
      static Outer make() { Outer value = {{3, 4}, 9}; return value; }`;
    const body = `Outer value = make(); state.mut().result = value.pair.left + value.pair.right + value.extra;`;
    expect(await run(helper, body)).toBe(16n);
  });

  test("a const aggregate reference binds to a temporary", async () => {
    const helper = `static uint64 sum(const Pair& value) { return value.left + value.right; }`;
    expect(await run(helper, `state.mut().result = sum(Pair{3, 4});`)).toBe(7n);
  });

  test("union scalar members alias the same storage", async () => {
    const helper = `union Bits { uint64 wide; uint32 low; };`;
    const body = `Bits bits; bits.wide = 4294967296ull; bits.low = 1; state.mut().result = bits.wide;`;
    expect(await run(helper, body)).toBe(4294967297n);
  });
});
