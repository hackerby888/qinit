import { CORE_PATH } from "../../../test-utils/paths";
// Differential gtest for BitArray<L> (bit_4096) compiled from the real qpi.h inline bodies: set/get of individual bits + setAll.
import { coreGtest } from "./core-gtest";
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildCorpusRunner } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const BITS = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { bit_4096 flags; };
  struct Set_input { uint64 index; uint64 value; }; struct Set_output {};
  struct Get_input { uint64 index; }; struct Get_output { uint64 value; };
  struct SetAll_input { uint64 value; }; struct SetAll_output {};
  PUBLIC_PROCEDURE(Set) { state.mut().flags.set(input.index, input.value ? 1 : 0); }
  PUBLIC_FUNCTION(Get) { output.value = state.get().flags.get(input.index) ? 1 : 0; }
  PUBLIC_PROCEDURE(SetAll) { state.mut().flags.setAll(input.value ? 1 : 0); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Set, 1); REGISTER_USER_FUNCTION(Get, 1); REGISTER_USER_PROCEDURE(SetAll, 2);
  }
};`;

const BITS_GTEST = coreGtest("Bits", `TEST(Bits, SetGetSetAll) {
  ContractTestingHarness t;
  QPI::id u = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(u, 1000000000ll);
  CONTRACT_STATE_TYPE::Set_input s{}; CONTRACT_STATE_TYPE::Get_input g{};
  s.index = 100; s.value = 1; t.invoke<CONTRACT_STATE_TYPE::Set_output>(1, s, 0, u);
  s.index = 2050; s.value = 1; t.invoke<CONTRACT_STATE_TYPE::Set_output>(1, s, 0, u);
  g.index = 100; EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::Get_output>(1, g).value, 1ull);
  g.index = 2050; EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::Get_output>(1, g).value, 1ull);
  g.index = 101; EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::Get_output>(1, g).value, 0ull);
  // clear bit 100
  s.index = 100; s.value = 0; t.invoke<CONTRACT_STATE_TYPE::Set_output>(1, s, 0, u);
  g.index = 100; EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::Get_output>(1, g).value, 0ull);
  g.index = 2050; EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::Get_output>(1, g).value, 1ull);
  // setAll(1) then spot-check
  CONTRACT_STATE_TYPE::SetAll_input sa{}; sa.value = 1; t.invoke<CONTRACT_STATE_TYPE::SetAll_output>(2, sa, 0, u);
  g.index = 7; EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::Get_output>(1, g).value, 1ull);
  g.index = 4095; EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::Get_output>(1, g).value, 1ull);
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

describe("differential gtest — BitArray (bit_4096 set/get/setAll)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my BitArray contract passes the native gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "bitarray-diff-"));
    const contractPath = join(dir, "Bits.h");
    writeFileSync(contractPath, BITS);

    const testPath = join(dir, "Bits.test.cpp");
    writeFileSync(testPath, BITS_GTEST);
    const built = await buildCorpusRunner({
      corpusPath: testPath, contractPath, name: "Bits", stateType: "Bits", slot: 28,
      corePath: CORE, outDir: dir,
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: BITS, name: "Bits", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
