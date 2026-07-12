import { test, expect } from "bun:test";
import { clangdErrorLines, clangdErrorCount } from "../../src/clangd-diag";

// Captured `clangd --check` output shapes (verified against real runs). A broken contract emits
// `E[ts] [code] Line N: …` diagnostics PLUS tweak-availability probes (SpecialMembers "Class body in
const BROKEN = [
  "I[00:00:00.000] Building AST...",
  "E[00:00:00.001] [undeclared_var_use] Line 19: use of undeclared identifier 'Counter'",
  "E[00:00:00.001] [undeclared_var_use] Line 22: use of undeclared identifier 'Counter'",
  "E[00:00:00.001] [undeclared_var_use] Line 26: use of undeclared identifier 'Counter_Get_inputType'",
  "E[00:00:00.001] tweak: SpecialMembers ==> FAIL: Class body in wrong file: C:\\x\\Proxy.h:8:1",
  "E[00:00:00.001] tweak: SpecialMembers ==> FAIL: Class body in wrong file: C:\\x\\Proxy.h:12:5",
  "I[00:00:00.002] All checks completed, 5 errors",
].join("\n");

// A contract that resolves cleanly still emits tweak probes (the body lives in the .h, not the prefix).
const CLEAN = [
  "I[00:00:00.000] Building AST...",
  "E[00:00:00.001] tweak: SpecialMembers ==> FAIL: Class body in wrong file: C:\\x\\Counter.h:9:1",
  "I[00:00:00.002] All checks completed, 1 errors",
].join("\n");

test("counts only real code diagnostics (not the tweak-probe noise the summary inflates)", () => {
  expect(clangdErrorCount(BROKEN)).toBe(3); // the 3 undeclared_var_use lines, NOT the summary's 5
  expect(clangdErrorLines(BROKEN).every((l) => /\[undeclared_var_use\]/.test(l))).toBe(true);
});

test("a resolving contract is 0 errors even though its summary says otherwise", () => {
  expect(clangdErrorCount(CLEAN)).toBe(0); // the lone tweak FAIL must NOT count
});

test("regression guard: the gate's old `/error:/` filter was blind to clangd's format", () => {
  // clangd diagnostics contain no literal "error:" — the old filter matched nothing and PASSED broken code
  expect(BROKEN.split("\n").filter((l) => /error:|fatal error:/.test(l))).toHaveLength(0);
  // the current detector is not blind
  expect(clangdErrorCount(BROKEN)).toBeGreaterThan(0);
});

test("tolerates empty / noise-only output", () => {
  expect(clangdErrorCount("")).toBe(0);
  expect(clangdErrorCount("I[..] Building AST...\nI[..] All checks completed, 0 errors")).toBe(0);
});
