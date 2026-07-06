// HashMap/HashSet maintenance parity: set() must reuse the first marked-for-removal slot
// (native probe semantics — slot placement is state bytes), cleanup() must compact exactly
// like the native rehash, needsCleanup() reflects the mark-removal counter, and a map whose
// slots are all marked (full -> emptied) must still accept inserts.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    HashMap<uint64, uint64, 16> hm;
    HashMap<uint64, uint64, 4> tiny;
    HashSet<uint64, 16> hs;
    sint64 tinyIdx;
    uint64 needs50;
    uint64 needs10;
    uint64 hsNeeds;
  };

  struct Run_input {};
  struct Run_output {};
  struct Run_locals { uint64 k; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Run)
  {
    for (locals.k = 1; locals.k <= 12; locals.k = locals.k + 1) {
      state.mut().hm.set(locals.k, locals.k * 100);
    }
    for (locals.k = 1; locals.k <= 6; locals.k = locals.k + 1) {
      state.mut().hm.removeByKey(locals.k);
    }
    for (locals.k = 21; locals.k <= 26; locals.k = locals.k + 1) {
      state.mut().hm.set(locals.k, locals.k * 100);
    }

    state.mut().needs50 = state.get().hm.needsCleanup() ? 1 : 0;
    state.mut().needs10 = state.get().hm.needsCleanup(10) ? 1 : 0;
    state.mut().hm.cleanup();

    for (locals.k = 1; locals.k <= 4; locals.k = locals.k + 1) {
      state.mut().tiny.set(locals.k, locals.k);
    }
    for (locals.k = 1; locals.k <= 4; locals.k = locals.k + 1) {
      state.mut().tiny.removeByKey(locals.k);
    }
    state.mut().tinyIdx = state.mut().tiny.set(99, 7);

    for (locals.k = 1; locals.k <= 10; locals.k = locals.k + 1) {
      state.mut().hs.add(locals.k * 3);
    }
    for (locals.k = 1; locals.k <= 5; locals.k = locals.k + 1) {
      state.mut().hs.remove(locals.k * 3);
    }
    for (locals.k = 30; locals.k <= 34; locals.k = locals.k + 1) {
      state.mut().hs.add(locals.k);
    }
    state.mut().hsNeeds = state.get().hs.needsCleanup(20) ? 1 : 0;
    state.mut().hs.cleanupIfNeeded(20);
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Run, 1);
  }
};`;

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential — HashMap set-reuse + cleanup state parity", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("state bytes after remove/reuse/cleanup match native exactly", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "hm-cleanup-"));
    const contractPath = join(dir, "HmP.h");
    writeFileSync(contractPath, SRC);

    const built = await buildContract({
      contractPath, name: "HmP", slot: 28, corePath: CORE, outDir: dir, skipVerify: true,
    });
    expect(built.ok).toBe(true);
    const nativeWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: SRC, name: "HmP", slot: 28, qpiHeader: HEADERS, arenaSz: 4 * 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const run = (wasm: Uint8Array) => {
      const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
      sim.deploy(28, wasm);
      const user = new Uint8Array(32).fill(7);
      sim.fund(user, 1_000_000n);
      sim.procedure(28, 1, undefined, { invocator: user });
      return sim.contracts.get(28)!.state().slice();
    };

    const nat = run(nativeWasm);
    const ours = run(mine.wasm);

    const firstDiff = nat.findIndex((b, i) => ours[i] !== b);
    if (firstDiff >= 0) {
      let diffs = 0;
      for (let i = 0; i < nat.length; i++) {
        if (nat[i] !== ours[i]) diffs++;
      }
      console.log(`  STATE DIVERGENCE at byte ${firstDiff}: native=${nat[firstDiff]} ours=${ours[firstDiff]} (${diffs} of ${nat.length} differ)`);
    }
    expect(firstDiff).toBe(-1);
  }, 180000);
});
