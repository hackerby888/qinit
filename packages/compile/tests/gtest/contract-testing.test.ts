// Verifies that the engine's generic runContractTesting binding reproduces the QUTIL corpus outcome previously validated by qutil-bridge.ts:runUpstream. The same
import { describe, test, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { runContractTesting } from "@qinit/engine";
import { CORE, wasiAvailable, buildRunner, buildContractsOurs } from "../support/qutil-bridge";

describe("runContractTesting — generic engine binding (QUTIL regression)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("QUTIL corpus >= 51 PASS via engine runContractTesting", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }

    const runner = await buildRunner(CORE);
    const contracts = await buildContractsOurs(CORE);
    const results = await runContractTesting(runner, contracts);

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    console.log(`\n  [engine] contract_qutil.cpp: ${passed} PASS · ${failed} FAIL (of ${results.length})`);
    for (const r of results.filter((r) => !r.passed).slice(0, 12)) {
      console.log(`  FAIL  ${r.name || ""} — ${r.message.replace(/\n/g, " ").slice(0, 110)}`);
    }
    expect(passed).toBeGreaterThanOrEqual(51);
  }, 300000);
});
