import { CORE_PATH } from "../../../test-utils/paths";
// Differential gtest for system-procedure locals: a lifecycle procedure (END_EPOCH_WITH_LOCALS) reads and writes its `locals.*` frame, which only works
import { coreGtest } from "./core-gtest";
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildCorpusRunner } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const EPOCHER = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 acc; uint64 epochs; };
  struct Get_input {}; struct Get_output { uint64 acc; uint64 epochs; };
  struct END_EPOCH_locals { uint64 a; uint64 b; };
  PUBLIC_FUNCTION(Get) { output.acc = state.get().acc; output.epochs = state.get().epochs; }
  END_EPOCH_WITH_LOCALS() {
    locals.a = 7;
    locals.b = locals.a * 6;           // 42 — computed via the locals frame
    state.mut().acc += locals.b;        // accumulates +42 each epoch boundary
    state.mut().epochs += 1;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;

// epochLength is 3000 ticks (Sim TESTNET_EPOCH_DURATION); each boundary crossing fires END_EPOCH once.
const EPOCHER_GTEST = coreGtest("Epoch", `TEST(Epoch, EndEpochUsesLocals) {
  ContractTestingHarness t;
  Epoch::Get_input g{};
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).acc, 0ull);
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).epochs, 0ull);
  t.endEpoch();                            // cross one epoch boundary
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).epochs, 1ull);
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).acc, 42ull);
  t.endEpoch();                            // cross a second boundary
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).epochs, 2ull);
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).acc, 84ull);
}
`);

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — Epoch (END_EPOCH sysproc locals)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Epoch.wasm runs END_EPOCH using its locals frame", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "epoch-diff-"));
    const contractPath = join(dir, "Epoch.h");
    writeFileSync(contractPath, EPOCHER);

    const testPath = join(dir, "Epoch.test.cpp");
    writeFileSync(testPath, EPOCHER_GTEST);
    const built = await buildCorpusRunner({
      corpusPath: testPath, contractPath, name: "Epoch", stateType: "Epoch", slot: 28,
      corePath: CORE, outDir: dir,
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: EPOCHER, name: "Epoch", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
