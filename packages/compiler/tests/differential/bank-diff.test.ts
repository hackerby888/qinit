import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, QINIT_ROOT } from "../../../../test-utils/paths";
// Differential coverage for Bank's HashMap and Array operations.
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { wasiToolchain } from "../support/container-toolchains";
import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);
const BANK = readFileSync(QINIT_ROOT + "/fixtures/Bank.h", "utf8");

// Two distinct funded ids; Set is a procedure (it=1), BalanceOf func it=1, Stats func it=2.
const BANK_GTEST = coreGtest(
  "Bank",
  `TEST(Bank, SetThenBalanceOf) {
  ContractTestingHarness t;
  QPI::id u = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(u, 1000000000);
  Bank::Set_input s{}; s.who = u; s.amount = 100ull;
  t.invoke<Bank::Set_output>(1, s, 0, u);
  Bank::BalanceOf_input b{}; b.who = u;
  EXPECT_EQ(t.call<Bank::BalanceOf_output>(1, b).amount, 100ull);
}
TEST(Bank, MissingKeyIsZero) {
  ContractTestingHarness t;
  QPI::id u = t.idFromSeed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  Bank::BalanceOf_input b{}; b.who = u;
  EXPECT_EQ(t.call<Bank::BalanceOf_output>(1, b).amount, 0ull);
}
TEST(Bank, ReplaceSameKeyKeepsPopulationOne) {
  ContractTestingHarness t;
  QPI::id u = t.idFromSeed("ccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
  t.fund(u, 1000000000);
  Bank::Set_input s{}; s.who = u; s.amount = 100ull;
  t.invoke<Bank::Set_output>(1, s, 0, u);
  s.amount = 30ull;
  t.invoke<Bank::Set_output>(1, s, 0, u);
  Bank::BalanceOf_input b{}; b.who = u;
  EXPECT_EQ(t.call<Bank::BalanceOf_output>(1, b).amount, 30ull);
  Bank::Stats_input si{};
  auto st = t.call<Bank::Stats_output>(2, si);
  EXPECT_EQ(st.total, 130ull);
  EXPECT_EQ(st.population, 1ull);
}
TEST(Bank, TwoKeysPopulationTwo) {
  ContractTestingHarness t;
  QPI::id u1 = t.idFromSeed("ddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
  QPI::id u2 = t.idFromSeed("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  t.fund(u1, 1000000000);
  t.fund(u2, 1000000000);
  Bank::Set_input s{}; s.who = u1; s.amount = 100ull;
  t.invoke<Bank::Set_output>(1, s, 0, u1);
  s.who = u2; s.amount = 50ull;
  t.invoke<Bank::Set_output>(1, s, 0, u2);
  Bank::BalanceOf_input b{}; b.who = u1;
  EXPECT_EQ(t.call<Bank::BalanceOf_output>(1, b).amount, 100ull);
  b.who = u2;
  EXPECT_EQ(t.call<Bank::BalanceOf_output>(1, b).amount, 50ull);
  Bank::Stats_input si{};
  auto st = t.call<Bank::Stats_output>(2, si);
  EXPECT_EQ(st.total, 150ull);
  EXPECT_EQ(st.population, 2ull);
}
`,
);

const wasi = wasiToolchain();

describe("differential gtest — Bank (HashMap + Array)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Bank.wasm passes the native Bank gtest", async () => {
    if (!wasi.available) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const runnerWasm = await buildDifferentialRunner({
      corePath: CORE,
      source: BANK,
      testSource: BANK_GTEST,
      name: "Bank",
      tempPrefix: "bank-diff-",
    });

    const mine = await compileContract({
      source: BANK,
      contractName: "Bank",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSizeBytes: 1024 * 1024,
    });
    expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
