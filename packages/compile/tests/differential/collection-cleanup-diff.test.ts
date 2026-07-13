import { CORE_PATH } from "../../../../test-utils/paths";
// Collection maintenance parity checks: - remove() marks emptied PoVs and updates `_markRemovalCounter`.
import { describe, test, expect, beforeAll } from "bun:test";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    Collection<uint64, 16> coll;
    Collection<uint64, 4> tiny;
    sint64 bIdx0;
    sint64 bIdx1;
    uint64 needs50;
    uint64 needs5;
    sint64 tIdx;
  };

  struct Run_input {};
  struct Run_output {};
  struct Run_locals {
    id povA;
    id povB;
    id povC;
  };
  PUBLIC_PROCEDURE_WITH_LOCALS(Run)
  {
    locals.povA = id(2, 0, 0, 0);
    locals.povB = id(18, 0, 0, 0);
    locals.povC = id(34, 0, 0, 0);

    state.mut().coll.add(locals.povA, 11, 5);
    state.mut().coll.add(locals.povA, 12, 1);
    state.mut().coll.add(locals.povA, 13, 9);
    state.mut().coll.add(locals.povC, 31, 7);
    state.mut().coll.add(locals.povC, 32, 3);
    state.mut().bIdx0 = state.mut().coll.add(locals.povB, 21, 4);
    state.mut().bIdx1 = state.mut().coll.add(locals.povB, 22, 8);

    state.mut().coll.remove(state.get().bIdx1);
    state.mut().coll.remove(state.get().bIdx0);

    state.mut().needs50 = state.get().coll.needsCleanup() ? 1 : 0;
    state.mut().needs5 = state.get().coll.needsCleanup(5) ? 1 : 0;
    state.mut().coll.cleanup();

    state.mut().tIdx = state.mut().tiny.add(id(3, 0, 0, 0), 77, 1);
    state.mut().tiny.remove(state.get().tIdx);
    state.mut().tiny.cleanupIfNeeded(0);
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Run, 1);
  }
};`;

const wasi = wasiToolchain();

describe("differential — Collection needsCleanup/cleanup state parity", () => {
  beforeAll(async () => {
    await initK12();
  });

  toolchainTest(
    "state bytes after remove/mark/cleanup match native exactly",
    wasi,
    async () => {
      const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "coll-cleanup-"));
      const contractPath = join(dir, "ClnP.h");
      writeFileSync(contractPath, SRC);

      const built = await buildContract({
        contractPath,
        name: "ClnP",
        slot: 29,
        corePath: CORE,
        outDir: dir,
        skipVerify: true,
      });
      expect(built.ok).toBe(true);
      const nativeWasm = new Uint8Array(readFileSync(built.so!));

      const mine = await compileContract({
        source: SRC,
        name: "ClnP",
        slot: 29,
        qpiHeader: HEADERS,
        arenaSz: 4 * 1024 * 1024,
      });
      expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

      const run = (wasm: Uint8Array) => {
        const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
        sim.deploy(29, wasm);
        const user = new Uint8Array(32).fill(9);
        sim.fund(user, 1_000_000n);
        sim.procedure(29, 1, undefined, { invocator: user });
        return sim.contracts.get(29)!.state().slice();
      };

      const nat = run(nativeWasm);
      const ours = run(mine.wasm);

      const firstDiff = nat.findIndex((b, i) => ours[i] !== b);
      if (firstDiff >= 0) {
        let diffs = 0;
        for (let i = 0; i < nat.length; i++) {
          if (nat[i] !== ours[i]) diffs++;
        }
        console.log(
          `  STATE DIVERGENCE at byte ${firstDiff}: native=${nat[firstDiff]} ours=${ours[firstDiff]} (${diffs} of ${nat.length} differ)`,
        );
      }
      expect(firstDiff).toBe(-1);

      // Anchor against known semantics so both sides being identically wrong can't pass: mrc=1 of 16 slots means needsCleanup()
      const tinyOff = 1816; // Collection<uint64,16>: povs 1024 + flags 8 + elements 768 + pop/mrc 16
      const dv = new DataView(nat.buffer, nat.byteOffset);
      const scalarBase = tinyOff + 4 * 64 + 8 + 4 * 48 + 16;
      expect(dv.getBigUint64(scalarBase + 16, true)).toBe(0n); // needs50
      expect(dv.getBigUint64(scalarBase + 24, true)).toBe(1n); // needs5
    },
    180000,
  );
});
