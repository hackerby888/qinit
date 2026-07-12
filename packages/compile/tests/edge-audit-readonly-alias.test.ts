import { CORE_PATH } from "../../../test-utils/paths";
// state.get() exposes read-only contract state. A non-const reference must not turn a nested
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader(CORE_PATH);

const wrap = (stateData: string, entry: string, registration: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Pair { uint64 left; uint64 right; };
  struct StateData { ${stateData} };
  static void bump(uint64& value) { value += 1; }
  struct Go_input {}; struct Go_output {};
  ${entry}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { ${registration} }
};`;

async function expectReadonlyRejection(source: string) {
  const result = await compileContract({ source, name: "ReadonlyAliasEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors.some((d) => /state\.get|read.?only|const.*reference|cannot.*bind|non.?const/i.test(d.message))).toBe(true);
  expect(result.wasm).toHaveLength(0);
}

describe("edge audit — state.get read-only aliasing", () => {
  test("a procedure cannot pass a state.get scalar to a non-const reference", async () => {
    await expectReadonlyRejection(wrap(
      `uint64 result;`,
      `PUBLIC_PROCEDURE(Go) { bump(state.get().result); }`,
      `REGISTER_USER_PROCEDURE(Go, 1);`,
    ));
  });

  test("a function cannot mutate state.get through a non-const reference", async () => {
    await expectReadonlyRejection(wrap(
      `uint64 result;`,
      `PUBLIC_FUNCTION(Go) { bump(state.get().result); }`,
      `REGISTER_USER_FUNCTION(Go, 1);`,
    ));
  });

  test("read-only protection follows nested aggregate members", async () => {
    await expectReadonlyRejection(wrap(
      `Pair pair;`,
      `PUBLIC_PROCEDURE(Go) { bump(state.get().pair.left); }`,
      `REGISTER_USER_PROCEDURE(Go, 1);`,
    ));
  });
});
