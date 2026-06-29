// Differential gtest for user-defined helper functions: plain value helpers (triple/addThem, called
// directly) and a PRIVATE_PROCEDURE invoked via CALL() with the caller's in/out lvalues.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { runTestsAgainst, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const HELPERS = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 total; };
  struct Apply_input { uint64 x; }; struct Apply_output { uint64 y; };
  struct Bump_input { uint64 by; }; struct Bump_output { uint64 newTotal; };
  struct AddAndBump_input { uint64 a; uint64 b; }; struct AddAndBump_output { uint64 sum; uint64 total; };
  struct AddAndBump_locals { Bump_input bi; Bump_output bo; };
  struct Total_input {}; struct Total_output { uint64 total; };

  static uint64 triple(uint64 v) { return v * 3; }
  static uint64 addThem(uint64 a, uint64 b) { return a + b; }

  PRIVATE_PROCEDURE(Bump)
  {
    state.mut().total += input.by;
    output.newTotal = state.get().total;
  }

  PUBLIC_FUNCTION(Apply) { output.y = triple(input.x); }

  PUBLIC_PROCEDURE_WITH_LOCALS(AddAndBump)
  {
    output.sum = addThem(input.a, input.b);
    locals.bi.by = output.sum;
    CALL(Bump, locals.bi, locals.bo);
    output.total = locals.bo.newTotal;
  }

  PUBLIC_FUNCTION(Total) { output.total = state.get().total; }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Apply, 1);
    REGISTER_USER_PROCEDURE(AddAndBump, 1);
    REGISTER_USER_FUNCTION(Total, 2);
  }
};
`;

const HELPERS_GTEST = `TEST(Helpers, ValueHelperReturn) {
  ContractTest t;
  Helpers::Apply_input a{}; a.x = 5ull;
  EXPECT_EQ(t.call<Helpers::Apply_output>(1, a).y, 15ull);
}
TEST(Helpers, PrivateCallMutatesStateViaCallerLvalues) {
  ContractTest t;
  QPI::id u = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(u, 1000000000ll);
  Helpers::AddAndBump_input ab{}; ab.a = 3ull; ab.b = 4ull;
  auto r1 = t.invoke<Helpers::AddAndBump_output>(1, ab, 0, u);
  EXPECT_EQ(r1.sum, 7ull);
  EXPECT_EQ(r1.total, 7ull);
  ab.a = 10ull; ab.b = 0ull;
  auto r2 = t.invoke<Helpers::AddAndBump_output>(1, ab, 0, u);
  EXPECT_EQ(r2.sum, 10ull);
  EXPECT_EQ(r2.total, 17ull);
  Helpers::Total_input ti{};
  EXPECT_EQ(t.call<Helpers::Total_output>(2, ti).total, 17ull);
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

describe("differential gtest — Helpers (value helpers + PRIVATE_ via CALL)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Helpers.wasm passes the native Helpers gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "helpers-diff-"));
    const contractPath = join(dir, "Helpers.h");
    writeFileSync(contractPath, HELPERS);

    const built = await buildContract({
      contractPath, name: "Helpers", slot: 28, corePath: CORE, outDir: dir,
      skipVerify: true, testSource: HELPERS_GTEST, testPath: "Helpers.test.cpp",
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: HELPERS, name: "Helpers", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runTestsAgainst(runnerWasm, mine.wasm);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
