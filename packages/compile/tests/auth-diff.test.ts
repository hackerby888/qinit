// Differential gtest for id-valued body codegen: qpi.invocator() captured into state (id copy), an
// id == id guard, and reading an id back out — the dominant access-control pattern.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { runTestsAgainst, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const AUTH = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { id last; uint64 count; };
  struct Remember_input {}; struct Remember_output {};
  struct IsLast_input { id who; }; struct IsLast_output { uint64 yes; };
  struct LastId_input {}; struct LastId_output { id who; };
  struct Count_input {}; struct Count_output { uint64 n; };
  PUBLIC_PROCEDURE(Remember) {
    state.mut().last = qpi.invocator();
    state.mut().count++;
  }
  PUBLIC_FUNCTION(IsLast) {
    output.yes = (state.get().last == input.who) ? 1 : 0;
  }
  PUBLIC_FUNCTION(LastId) {
    output.who = state.get().last;
  }
  PUBLIC_FUNCTION(Count) {
    output.n = state.get().count;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Remember, 1);
    REGISTER_USER_FUNCTION(IsLast, 1);
    REGISTER_USER_FUNCTION(LastId, 2);
    REGISTER_USER_FUNCTION(Count, 3);
  }
};
`;

const AUTH_GTEST = `TEST(Auth, InvocatorCapturedAndCompared) {
  ContractTest t;
  QPI::id u = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  QPI::id other = t.idFromSeed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  t.fund(u, 1000000000ll);
  Auth::Remember_input r{};
  t.invoke<Auth::Remember_output>(1, r, 0, u);
  Auth::IsLast_input q{}; q.who = u;
  EXPECT_EQ(t.call<Auth::IsLast_output>(1, q).yes, 1ull);
  q.who = other;
  EXPECT_EQ(t.call<Auth::IsLast_output>(1, q).yes, 0ull);
  Auth::LastId_input li{};
  EXPECT_TRUE(t.call<Auth::LastId_output>(2, li).who == u);
  Auth::Count_input ci{};
  EXPECT_EQ(t.call<Auth::Count_output>(3, ci).n, 1ull);
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

describe("differential gtest — Auth (qpi.invocator + id compare)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Auth.wasm passes the native Auth gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "auth-diff-"));
    const contractPath = join(dir, "Auth.h");
    writeFileSync(contractPath, AUTH);

    const built = await buildContract({
      contractPath, name: "Auth", slot: 28, corePath: CORE, outDir: dir,
      skipVerify: true, testSource: AUTH_GTEST, testPath: "Auth.test.cpp",
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: AUTH, name: "Auth", slot: 28, qpiHeader: HEADERS, arenaSz: 64 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runTestsAgainst(runnerWasm, mine.wasm);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
