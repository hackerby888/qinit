import { test, expect } from "bun:test";
import { resolveTrapBacktrace, decodeTrapCause, formatTrapBacktrace } from "../src/backtrace";
import { join } from "node:path";

// Build-time line map generated from the -O0 -g trap fixture (test/wasm_trap_fixture.c).
const LINEMAP = join(import.meta.dir, "__fixtures__", "trap.lines.json");
// Real WAMR auto-dump (classic interp + DUMP_CALL_STACK, -O0): do_div's div ip = 0xf1, dispatch's call ip = 0xaf.
const LOG = [
  "260612010101 000:000(000).55900003.216 prior log line",
  "",
  "#00: 0x0000f1 - $f1",
  "#01: 0x0000af - dispatch",
  "",
  "Exception: integer divide by zero",
  "260612010101 ERROR LITEWASM dispatch trap idx=28 it=1 kind=1 — integer divide by zero",
].join("\n");

test("parse frames + decode cause (no line map)", () => {
  const bt = resolveTrapBacktrace(LOG)!;
  expect(bt).not.toBeNull();
  expect(bt.exception).toBe("integer divide by zero");
  expect(bt.cause).toContain("divide");
  expect(bt.frames.map((f) => f.off)).toEqual([0xf1, 0xaf]);
});

test("line map -> 100% function + line resolution", () => {
  const bt = resolveTrapBacktrace(LOG, { lineMapPath: LINEMAP })!;
  expect(bt.frames[0].func).toBe("do_div");
  expect(bt.frames[0].line).toBe(8);    // the divide (return a / b)
  expect(bt.frames[1].func).toBe("dispatch");
  expect(bt.frames[1].line).toBe(12);   // the call site (do_div(7, it))
  const out = formatTrapBacktrace(bt);
  expect(out).toContain("do_div");
  expect(out).toContain(":8");
  expect(out).toContain("dispatch");
  expect(out).toContain(":12");
  expect(out).toContain("divide");
});

test("trap dictionary", () => {
  expect(decodeTrapCause("integer divide by zero")).toContain("div");
  expect(decodeTrapCause("out of bounds memory access")).toContain("out-of-range");
  expect(decodeTrapCause("unreachable")).toContain("abort");
  expect(decodeTrapCause("novel trap text")).toBe("novel trap text");
});
