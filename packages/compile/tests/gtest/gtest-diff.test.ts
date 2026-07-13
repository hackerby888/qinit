import { CORE_PATH } from "../../../../test-utils/paths";
// Differential gtest validation: drive MY TS-compiled contract wasm with the SAME gtest cases that pin the native-clang build.
import { coreGtest } from "../support/core-gtest";
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildCorpusRunner } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const COUNTER = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; };
  struct Inc_input {}; struct Inc_output {};
  struct Get_input {}; struct Get_output { uint64 value; };
  PUBLIC_PROCEDURE(Inc) { state.mut().counter += 1; }
  PUBLIC_FUNCTION(Get) { output.value = state.get().counter; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Inc, 1);
    REGISTER_USER_FUNCTION(Get, 1);
  }
};
`;

// Core-lite-style gtest cases — the same assertions a native build validates.
const COUNTER_GTEST = coreGtest(
  "Counter",
  `TEST(Counter, StartsAtZero) {
  ContractTestingHarness t;
  Counter::Get_input in{};
  EXPECT_EQ(t.call<Counter::Get_output>(1, in).value, 0ull);
}
TEST(Counter, IncrementsAreCumulative) {
  ContractTestingHarness t;
  QPI::id user = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(user, 1000000000);
  Counter::Inc_input in{};
  for (int i = 0; i < 5; i++) t.invoke<Counter::Inc_output>(1, in, 0, user);
  Counter::Get_input g{};
  EXPECT_EQ(t.call<Counter::Get_output>(1, g).value, 5ull);  // read via Get (thost-mediated)
}
TEST(Counter, EachTestStartsFresh) {
  ContractTestingHarness t;
  Counter::Get_input g{};
  EXPECT_EQ(t.call<Counter::Get_output>(1, g).value, 0ull);
}
`,
);

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — my contract vs native test logic", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Counter.wasm passes the native Counter gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping native test-runner build)");
      return;
    }

    // 1. Native build of the combined Counter contract + gtest → the test runner.
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "gtest-diff-"));
    const contractPath = join(dir, "Counter.h");
    writeFileSync(contractPath, COUNTER);

    const testPath = join(dir, "Counter.test.cpp");
    writeFileSync(testPath, COUNTER_GTEST);
    const built = await buildCorpusRunner({
      corpusPath: testPath,
      contractPath,
      name: "Counter",
      stateType: "Counter",
      slot: 28,
      corePath: CORE,
      outDir: dir,
    });
    expect(built.ok, built.stderr).toBe(true);
    const runnerWasm = new Uint8Array(await (await import("node:fs/promises")).readFile(built.so!));

    // 2. My TS compiler builds the contract under test.
    const mine = await compileContract({
      source: COUNTER,
      name: "Counter",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 64 * 1024,
    });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    // 3. Drive MY contract with the NATIVE test logic.
    const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
