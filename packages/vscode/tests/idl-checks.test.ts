import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { idlChecks } from "../src/lint/idl-checks";

test("duplicate function index is flagged", () => {
  const rules = idlChecks("REGISTER_USER_FUNCTION(getA, 1); REGISTER_USER_FUNCTION(getB, 1);").map((f) => f.rule);
  expect(rules).toContain("qpi/dup-fn-index");
});

test("a function and a procedure may share an index (separate index spaces)", () => {
  expect(idlChecks("REGISTER_USER_FUNCTION(getA, 1); REGISTER_USER_PROCEDURE(doB, 1);")).toEqual([]);
});

test("unregistered PUBLIC_* is flagged; registered is not", () => {
  const src = `
    PUBLIC_FUNCTION(getA) { }
    PUBLIC_PROCEDURE_WITH_LOCALS(doB) { }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES { REGISTER_USER_FUNCTION(getA, 1); }
  `;
  const f = idlChecks(src);
  expect(f.some((x) => x.rule === "qpi/unregistered" && x.message.includes("doB"))).toBe(true);
  expect(f.some((x) => x.rule === "qpi/unregistered" && x.message.includes("getA"))).toBe(false);
});

test("commented-out macros are ignored", () => {
  expect(idlChecks("// PUBLIC_FUNCTION(ghost) {}\n/* REGISTER_USER_FUNCTION(x,1); REGISTER_USER_FUNCTION(y,1); */")).toEqual([]);
});

test("real fixtures: no duplicate-index false positives", () => {
  const dir = resolve("fixtures");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".h"))) {
    const dups = idlChecks(readFileSync(join(dir, f), "utf8")).filter((x) => x.rule.startsWith("qpi/dup")).map((x) => x.rule);
    expect({ file: f, dups }).toEqual({ file: f, dups: [] });
  }
});
