// Differential gtest for arithmetic body codegen: QPI safe-math (div/mod/sadd/min/max), a for-loop
// with break/continue, member-lvalue increment, and named constants — validated against native clang.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { runTestsAgainst, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const CALC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
constexpr uint64 CALC_CAP = 100;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 unused; };
  struct Div_input { uint64 a; uint64 b; }; struct Div_output { uint64 q; uint64 r; };
  struct SumTo_input { uint64 n; }; struct SumTo_output { uint64 s; };
  struct SumTo_locals { uint64 i; uint64 s; };
  PUBLIC_FUNCTION(Div) {
    output.q = div(input.a, input.b);
    output.r = mod(input.a, input.b);
  }
  PUBLIC_FUNCTION_WITH_LOCALS(SumTo) {
    locals.s = 0;
    for (locals.i = 1; locals.i <= input.n; locals.i++) {
      if (locals.i > CALC_CAP) break;
      locals.s = sadd(locals.s, locals.i);
    }
    output.s = locals.s;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Div, 1);
    REGISTER_USER_FUNCTION(SumTo, 2);
  }
};
`;

const CALC_GTEST = `TEST(Calc, SafeDivMod) {
  ContractTest t;
  Calc::Div_input a{}; a.a = 10ull; a.b = 3ull;
  auto r = t.call<Calc::Div_output>(1, a);
  EXPECT_EQ(r.q, 3ull);
  EXPECT_EQ(r.r, 1ull);
  Calc::Div_input z{}; z.a = 5ull; z.b = 0ull;
  auto rz = t.call<Calc::Div_output>(1, z);
  EXPECT_EQ(rz.q, 0ull);
  EXPECT_EQ(rz.r, 0ull);
}
TEST(Calc, LoopSumWithBreakCap) {
  ContractTest t;
  Calc::SumTo_input s{}; s.n = 5ull;
  EXPECT_EQ(t.call<Calc::SumTo_output>(2, s).s, 15ull);
  s.n = 200ull;
  EXPECT_EQ(t.call<Calc::SumTo_output>(2, s).s, 5050ull);
}
`;

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — Calc (safe math, loops, break, constants)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Calc.wasm passes the native Calc gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "calc-diff-"));
    const contractPath = join(dir, "Calc.h");
    writeFileSync(contractPath, CALC);

    const built = await buildContract({
      contractPath, name: "Calc", slot: 28, corePath: CORE, outDir: dir,
      skipVerify: true, testSource: CALC_GTEST, testPath: "Calc.test.cpp",
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: CALC, name: "Calc", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runTestsAgainst(runnerWasm, mine.wasm);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
