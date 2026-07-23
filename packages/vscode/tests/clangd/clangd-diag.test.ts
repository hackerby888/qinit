import { test, expect } from "bun:test";
import { clangdErrorLines, clangdErrorCount } from "../../src/clangd-diag";

const BROKEN = [
  "I[00:00:00.000] Building AST...",
  "E[00:00:00.001] [undeclared_var_use] Line 19: use of undeclared identifier 'Counter'",
  "E[00:00:00.001] [undeclared_var_use] Line 22: use of undeclared identifier 'Counter'",
  "E[00:00:00.001] [undeclared_var_use] Line 26: use of undeclared identifier 'Counter_Get_inputType'",
  "E[00:00:00.001] tweak: SpecialMembers ==> FAIL: Class body in wrong file: C:\\x\\Proxy.h:8:1",
  "E[00:00:00.001] tweak: SpecialMembers ==> FAIL: Class body in wrong file: C:\\x\\Proxy.h:12:5",
  "I[00:00:00.002] All checks completed, 5 errors",
].join("\n");

const CLEAN = [
  "I[00:00:00.000] Building AST...",
  "E[00:00:00.001] tweak: SpecialMembers ==> FAIL: Class body in wrong file: C:\\x\\Counter.h:9:1",
  "I[00:00:00.002] All checks completed, 1 errors",
].join("\n");

test("counts only real code diagnostics (not the tweak-probe noise the summary inflates)", () => {
  expect(clangdErrorCount(BROKEN)).toBe(3);
  expect(clangdErrorLines(BROKEN).every((l) => /\[undeclared_var_use\]/.test(l))).toBe(true);
});

test("a resolving contract is 0 errors even though its summary says otherwise", () => {
  expect(clangdErrorCount(CLEAN)).toBe(0);
});

test("regression guard: the gate's old `/error:/` filter was blind to clangd's format", () => {
  expect(BROKEN.split("\n").filter((l) => /error:|fatal error:/.test(l))).toHaveLength(0);
  expect(clangdErrorCount(BROKEN)).toBeGreaterThan(0);
});

test("tolerates empty / noise-only output", () => {
  expect(clangdErrorCount("")).toBe(0);
  expect(clangdErrorCount("I[..] Building AST...\nI[..] All checks completed, 0 errors")).toBe(0);
});
