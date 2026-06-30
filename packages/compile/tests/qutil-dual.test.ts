// Dev-only differential: run contract_qutil.cpp against BOTH backends (ours = @qinit/compile,
// native = clang) through the same runner, and classify each test. native is the reference.
// Gated by GTEST_DUAL because it pays for two contract builds. Run:  GTEST_DUAL=1 bun test tests/qutil-dual.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { CORE, wasiAvailable, buildRunner, buildContractsOurs, buildContractsNative, runUpstream, type TR } from "./qutil-bridge";

function classify(ours: TR | undefined, native: TR | undefined): string {
  const o = ours?.passed ?? false;
  const n = native?.passed ?? false;
  if (o && n) {
    return "ok";
  }
  if (!o && n) {
    return "COMPILER";
  }
  if (!o && !n) {
    return "BRIDGE";
  }
  return "SUSPECT";
}

describe("dual-backend differential — ours vs native", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("ours matches native per-test", async () => {
    if (!process.env.GTEST_DUAL) {
      console.log("  (set GTEST_DUAL=1 to run the dual differential)");
      return;
    }
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }

    const runner = await buildRunner(CORE);
    const rNative = await runUpstream(runner, await buildContractsNative(CORE));
    const rOurs = await runUpstream(runner, await buildContractsOurs(CORE));

    const byName = (rs: TR[]) => new Map(rs.map((r, i) => [r.name || String(i), r]));
    const on = byName(rOurs);
    const nn = byName(rNative);
    const names = [...new Set([...on.keys(), ...nn.keys()])];

    const buckets: Record<string, string[]> = { ok: [], COMPILER: [], BRIDGE: [], SUSPECT: [] };
    for (const name of names) {
      buckets[classify(on.get(name), nn.get(name))].push(name);
    }

    console.log(`\n  dual: ${buckets.ok.length} ok · ${buckets.COMPILER.length} COMPILER-BUG · ${buckets.BRIDGE.length} BRIDGE-BUG · ${buckets.SUSPECT.length} SUSPECT (of ${names.length})`);
    for (const name of buckets.COMPILER) {
      console.log(`  COMPILER  ${name} — ours fails, native passes (fix codegen)`);
    }
    for (const name of buckets.BRIDGE) {
      console.log(`  BRIDGE    ${name} — native fails (fix SHIM/thost/Sim)`);
    }
    for (const name of buckets.SUSPECT) {
      console.log(`  SUSPECT   ${name} — ours passes, native fails (oracle says fail — investigate)`);
    }

    const oursVec = names.map((n) => `${n}:${on.get(n)?.passed ? 1 : 0}`);
    const nativeVec = names.map((n) => `${n}:${nn.get(n)?.passed ? 1 : 0}`);
    expect(oursVec).toEqual(nativeVec);
  }, 600000);
});
