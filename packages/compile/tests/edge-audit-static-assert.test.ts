// QPI headers and contracts use static_assert as a compile-time safety boundary. A false assertion
import { describe, expect, test } from "bun:test";
import { compileContract, loadQpiHeader } from "../src/index";

const HEADERS = loadQpiHeader("/home/kali/Projects/core-lite");

const wrap = (classMember: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  ${classMember}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function compile(source: string) {
  return compileContract({ source, name: "StaticAssertEdge", slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
}

async function expectFalseAssertionRejected(source: string) {
  const result = await compile(source);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  expect(errors.some((d) => /static.?assert|static assertion|edge assertion failed/i.test(d.message))).toBe(true);
  expect(result.wasm).toHaveLength(0);
}

describe("edge audit — static_assert", () => {
  test("a false class-scope static_assert rejects the contract", async () => {
    await expectFalseAssertionRejected(wrap(`static_assert(1 == 2, "edge assertion failed");`, ""));
  });

  test("a false function-scope static_assert rejects the contract", async () => {
    await expectFalseAssertionRejected(wrap("", `static_assert(false, "edge assertion failed");`));
  });

  test("a true static_assert remains accepted", async () => {
    const result = await compile(wrap(`static_assert(sizeof(uint64) == 8, "uint64 layout");`, ""));
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(WebAssembly.validate(result.wasm)).toBe(true);
  });
});
