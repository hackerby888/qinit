// Differential gtest for chaining through a container element: Array<Struct,N>.set(i, s) and the read chain arr.get(i).field (the QEARN _initialRoundInfo.get(Epoch)._epochBonusAmount
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { runTestsAgainst, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const ROUNDS = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Info { uint64 bonus; uint64 locked; };
  struct StateData { Array<Info, 16> rounds; };
  struct Put_input { uint64 i; uint64 bonus; uint64 locked; }; struct Put_output {};
  struct Put_locals { Info info; };
  struct GetBonus_input { uint64 i; }; struct GetBonus_output { uint64 bonus; };
  struct GetLocked_input { uint64 i; }; struct GetLocked_output { uint64 locked; };

  PUBLIC_PROCEDURE_WITH_LOCALS(Put) {
    locals.info.bonus = input.bonus;
    locals.info.locked = input.locked;
    state.mut().rounds.set(input.i, locals.info);
  }
  PUBLIC_FUNCTION(GetBonus) { output.bonus = state.get().rounds.get(input.i).bonus; }
  PUBLIC_FUNCTION(GetLocked) { output.locked = state.get().rounds.get(input.i).locked; }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Put, 1);
    REGISTER_USER_FUNCTION(GetBonus, 1);
    REGISTER_USER_FUNCTION(GetLocked, 2);
  }
};
`;

const ROUNDS_GTEST = `TEST(Rounds, SetStructThenReadFieldChain) {
  ContractTest t;
  QPI::id u = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(u, 1000000000ll);
  Rounds::Put_input p{}; p.i = 3ull; p.bonus = 100ull; p.locked = 50ull;
  t.invoke<Rounds::Put_output>(1, p, 0, u);
  p.i = 7ull; p.bonus = 7ull; p.locked = 0ull;
  t.invoke<Rounds::Put_output>(1, p, 0, u);
  Rounds::GetBonus_input gb{}; gb.i = 3ull;
  EXPECT_EQ(t.call<Rounds::GetBonus_output>(1, gb).bonus, 100ull);
  Rounds::GetLocked_input gl{}; gl.i = 3ull;
  EXPECT_EQ(t.call<Rounds::GetLocked_output>(2, gl).locked, 50ull);
  gb.i = 7ull;
  EXPECT_EQ(t.call<Rounds::GetBonus_output>(1, gb).bonus, 7ull);
  gl.i = 7ull;
  EXPECT_EQ(t.call<Rounds::GetLocked_output>(2, gl).locked, 0ull);
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

describe("differential gtest — Rounds (chain through Array element)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Rounds.wasm passes the native Rounds gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "rounds-diff-"));
    const contractPath = join(dir, "Rounds.h");
    writeFileSync(contractPath, ROUNDS);

    const built = await buildContract({
      contractPath, name: "Rounds", slot: 28, corePath: CORE, outDir: dir,
      skipVerify: true, testSource: ROUNDS_GTEST, testPath: "Rounds.test.cpp",
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: ROUNDS, name: "Rounds", slot: 28, qpiHeader: HEADERS, arenaSz: 256 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runTestsAgainst(runnerWasm, mine.wasm);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
