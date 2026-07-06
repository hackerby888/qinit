// Collection BST rebalancing parity: adding >32 elements to one PoV with monotonically
// increasing priority degenerates the BST and triggers the native _rebuild (add() rebalances
// when population > 32 and search iterations exceed population/4). The rebuilt bst*Index
// fields are contract STATE BYTES — they feed the state digest, so ours must match native
// exactly, not just behaviorally.
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
  struct StateData { Collection<uint64, 64> coll; };

  struct Fill_input { uint64 n; };
  struct Fill_output {};
  struct Fill_locals { uint64 i; id pov; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Fill)
  {
    locals.pov = qpi.invocator();
    for (locals.i = 0; locals.i < input.n; locals.i = locals.i + 1) {
      state.mut().coll.add(locals.pov, locals.i * 7, (sint64)locals.i);
    }
  }

  struct Walk_input {};
  struct Walk_output { uint64 sum; sint64 count; };
  struct Walk_locals { sint64 idx; id pov; };
  PUBLIC_FUNCTION_WITH_LOCALS(Walk)
  {
    locals.pov = qpi.invocator();
    locals.idx = state.get().coll.headIndex(locals.pov);
    while (locals.idx != NULL_INDEX) {
      output.sum = output.sum * 31 + state.get().coll.element(locals.idx);
      output.count = output.count + 1;
      locals.idx = state.get().coll.nextElementIndex(locals.idx);
    }
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Fill, 1); REGISTER_USER_FUNCTION(Walk, 1);
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

describe("differential — Collection BST rebuild state parity", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("state bytes after rebuild-triggering adds match native exactly", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "coll-rebuild-"));
    const contractPath = join(dir, "CollP.h");
    writeFileSync(contractPath, SRC);

    const built = await buildContract({
      contractPath, name: "CollP", slot: 28, corePath: CORE, outDir: dir, skipVerify: true,
    });
    expect(built.ok).toBe(true);
    const nativeWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: SRC, name: "CollP", slot: 28, qpiHeader: HEADERS, arenaSz: 4 * 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const run = (wasm: Uint8Array) => {
      const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
      sim.deploy(28, wasm);
      const user = new Uint8Array(32).fill(7);
      sim.fund(user, 1_000_000n);
      // 48 adds with increasing priority: population passes 32 and the degenerate right-spine
      // search exceeds population/4 iterations, firing the native rebuild.
      const inBytes = new Uint8Array(8);
      new DataView(inBytes.buffer).setBigUint64(0, 48n, true);
      sim.procedure(28, 1, inBytes, { invocator: user });
      const walk = sim.query(28, 1);
      const state = sim.contracts.get(28)!.state().slice();
      return { walk, state };
    };

    const nat = run(nativeWasm);
    const ours = run(mine.wasm);

    // Behavioral parity: identical in-order traversal.
    expect(Buffer.from(ours.walk).toString("hex")).toBe(Buffer.from(nat.walk).toString("hex"));

    // State-byte parity: the BST index fields must match, or the on-chain state digest diverges.
    const firstDiff = nat.state.findIndex((b, i) => ours.state[i] !== b);
    if (firstDiff >= 0) {
      console.log(`  STATE DIVERGENCE at byte ${firstDiff}: native=${nat.state[firstDiff]} ours=${ours.state[firstDiff]}`);
      let diffs = 0;
      for (let i = 0; i < nat.state.length; i++) {
        if (nat.state[i] !== ours.state[i]) diffs++;
      }
      console.log(`  total differing bytes: ${diffs} of ${nat.state.length}`);
    }
    expect(firstDiff).toBe(-1);
  }, 180000);
});
