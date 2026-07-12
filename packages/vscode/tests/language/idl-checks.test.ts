import { test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { idlChecks } from "../../src/lint/idl-checks";

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

test("complex types in the PUBLIC interface are flagged; allowed types are not", () => {
  const bad = `
    PUBLIC_FUNCTION(getList) {}
    struct getList_input { id who; };
    struct getList_output { Collection<id, 1024> items; };
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES { REGISTER_USER_FUNCTION(getList, 1); }
  `;
  expect(idlChecks(bad).some((x) => x.rule === "qpi/public-complex-type" && x.message.includes("Collection"))).toBe(true);

  const ok = `
    PUBLIC_FUNCTION(getOk) {}
    struct getOk_input { id who; uint64 n; };
    struct getOk_output { Array<uint64, 8> vals; bit flag; };
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES { REGISTER_USER_FUNCTION(getOk, 1); }
  `;
  expect(idlChecks(ok).filter((x) => x.rule === "qpi/public-complex-type")).toEqual([]);
});

test("complex types outside the public interface (StateData / private I/O) are NOT flagged", () => {
  const src = `
    struct StateData { HashMap<id, uint64, 1024> balances; };
    PRIVATE_FUNCTION(helper) {}
    struct helper_input { Collection<id, 64> tmp; };
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES { }
  `;
  expect(idlChecks(src).filter((x) => x.rule === "qpi/public-complex-type")).toEqual([]);
});

test("real fixtures: no duplicate-index / public-complex-type false positives", () => {
  const dir = resolve("fixtures");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".h"))) {
    const hits = idlChecks(readFileSync(join(dir, f), "utf8"))
      .filter((x) => x.rule.startsWith("qpi/dup") || x.rule === "qpi/public-complex-type")
      .map((x) => x.rule);
    expect({ file: f, hits }).toEqual({ file: f, hits: [] });
  }
});
