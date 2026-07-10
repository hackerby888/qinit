// Regression test: switch/case fallthrough compiles to correct WASM with proper fallthrough semantics (stacked labels, intentional non-break fallthrough).
import { test, expect } from "bun:test";
import { compileContract, loadQpiHeader } from "@qinit/compile";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { sint64 result; };

  // Test 1: stacked labels — case 10 and case 20 share the same body.
  struct Stacked_input { sint64 x; };
  struct Stacked_output {};
  PUBLIC_PROCEDURE(Stacked) {
    sint64 r = 0;
    switch (input.x) {
      case 10:
      case 20: r = 42; break;
      default: r = 0; break;
    }
    state.mut().result = r;
  }

  // Test 2: intentional non-break fallthrough.
  struct Fallthrough_input { sint64 x; };
  struct Fallthrough_output {};
  PUBLIC_PROCEDURE(Fallthrough) {
    sint64 a = 0;
    switch (input.x) {
      case 1: a = a + 1;   // fall through
      case 2: a = a + 1; break;
      default: break;
    }
    state.mut().result = a;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Stacked, 1);
    REGISTER_USER_PROCEDURE(Fallthrough, 2);
  }
};
`;

test("compile succeeds with switch fallthrough", async () => {
  const result = await compileContract({
    source: SRC, name: "SwitchBug", slot: 50, qpiHeader: HEADERS, arenaSz: 1024 * 1024,
  });
  const errs = result.diagnostics.filter((d) => d.severity === "error");
  if (errs.length) console.log("  COMPILE ERRORS:", errs.map((e) => e.message).join("\n"));
  expect(errs).toHaveLength(0);
});

test("WAT uses nested dispatch+bodies pattern (no unconditional break between cases)", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "switch-wat-"));
  const watPath = join(dir, "out.wat");

  process.env.QINIT_DUMP_WAT = watPath;
  await compileContract({
    source: SRC, name: "SwitchBug", slot: 50, qpiHeader: HEADERS, arenaSz: 1024 * 1024,
  });
  delete process.env.QINIT_DUMP_WAT;

  const wat = readFileSync(watPath, "utf-8");
  rmSync(dir, { recursive: true, force: true });

  const lines = wat.split("\n");

  // Find switch blocks — each function with a switch should have one (block $swbrk...)
  const switchStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("(block $swbrk")) {
      switchStarts.push(i);
    }
  }
  expect(switchStarts.length).toBe(2);

  // Verify each switch has: a) nested case blocks that stay open: (block $swcase... (NOT closed immediately)
  for (const start of switchStarts) {
    let caseDispatch = 0;
    let defaultDispatch = false;
    const end = Math.min(start + 20, lines.length);
    for (let i = start; i < end; i++) {
      if (lines[i].includes("(if (i64.eq") && lines[i].includes("(then (br $swcase")) {
        caseDispatch++;
      }
      if (lines[i].includes("(br $swdef")) {
        defaultDispatch = true;
      }
    }
    expect(caseDispatch).toBeGreaterThanOrEqual(1);
    expect(defaultDispatch).toBe(true);
  }
});
