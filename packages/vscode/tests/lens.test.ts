import { test, expect } from "bun:test";
import { computeLenses } from "../src/lens";

const SRC = `
struct Counter : public ContractBase {
  PUBLIC_FUNCTION(get) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES {
    REGISTER_USER_FUNCTION(get, 1);
    REGISTER_USER_PROCEDURE(inc, 2);
  }
};`;

test("contract-level lenses sit on the state struct line", () => {
  const lenses = computeLenses(SRC);
  const structLine = SRC.split("\n").findIndex((l) => l.includes("ContractBase"));
  const onStruct = lenses.filter((l) => l.line === structLine).map((l) => l.command);
  expect(onStruct).toEqual(["qpi.build", "qpi.deploy", "qpi.gen"]);
});

test("one call lens per registered fn/proc", () => {
  const calls = computeLenses(SRC).filter((l) => l.command === "qpi.call");
  expect(calls.map((l) => l.title)).toEqual(["$(play) call get", "$(play) call inc"]);
});

test("commented-out registers get no lens", () => {
  const calls = computeLenses("// REGISTER_USER_FUNCTION(ghost, 1)\nstruct X : public ContractBase {};")
    .filter((l) => l.command === "qpi.call");
  expect(calls).toEqual([]);
});
