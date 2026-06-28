// genGtest scaffolds a gtest .cpp from a contract IDL: one TEST per registered procedure/function + an
// INITIALIZE smoke test, each in the `ContractTest t;` fixture-construction pattern. Pure string output — no clang.
import { test, expect } from "bun:test";
import { genGtest } from "../src/gen-gtest";
import type { ContractIdl } from "../src/idl";

const idl: ContractIdl = {
  name: "Counter",
  functions: { "1": { name: "Get", in: "", out: "uint64", inFields: [], outFields: [{ name: "value", type: "uint64" }] } },
  procedures: { "1": { name: "Inc", in: "", out: "", inFields: [], outFields: [] } },
};

test("genGtest emits an INITIALIZE smoke test + one TEST per entry, fixture-construction style", () => {
  const src = genGtest(idl);

  expect(src).toContain("TEST(Counter, Initialize)");
  expect(src).toContain("TEST(Counter, Inc)");
  expect(src).toContain("TEST(Counter, Get)");

  // every test constructs the fixture (per-test reset, mirroring core's ContractTestingX)
  expect(src.match(/ContractTest t;/g)?.length).toBe(3);

  // procedure -> invoke (with originator + reward), function -> call (read-only)
  expect(src).toContain("t.invoke<Counter::Inc_output>(1, in, 0, user)");
  expect(src).toContain("t.call<Counter::Get_output>(1, in)");
});
