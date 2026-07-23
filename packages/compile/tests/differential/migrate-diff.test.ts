import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// MIGRATE() parity for redeploy flow.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SRC_V1 = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 counter;
    uint64 total;
  };

  struct Bump_input {};
  struct Bump_output { uint64 counter; };
  PUBLIC_PROCEDURE(Bump)
  {
    state.mut().counter = state.get().counter + 1;
    state.mut().total = state.get().total + 10;
    output.counter = state.get().counter;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Bump, 1);
  }
};`;

const SRC_V2 = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct OldStateData {
    uint64 counter;
    uint64 total;
  };

  struct StateData {
    uint64 total;
    uint64 counter;
    uint64 migratedFrom;
  };

  MIGRATE()
  {
    state.mut().counter = oldState.counter;
    state.mut().total = oldState.total + 1000;
    state.mut().migratedFrom = oldState.counter * 2;
  }

  struct Bump_input {};
  struct Bump_output { uint64 counter; };
  PUBLIC_PROCEDURE(Bump)
  {
    state.mut().counter = state.get().counter + 1;
    state.mut().total = state.get().total + 10;
    output.counter = state.get().counter;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Bump, 1);
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

describe("differential — MIGRATE() redeploy state parity", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("state bytes across deploy -> mutate -> migrating redeploy -> mutate match native", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "migrate-"));

    const buildNative = async (name: string, src: string) => {
      const contractPath = join(dir, `${name}.h`);
      writeFileSync(contractPath, src);
      const built = await buildContract({
        contractPath,
        name,
        slot: 26,
        corePath: CORE,
        outDir: dir,
        skipVerify: true,
      });
      expect(built.ok).toBe(true);
      return new Uint8Array(readFileSync(built.so!));
    };
    const buildOurs = async (name: string, src: string) => {
      const mine = await compileContract({
        source: src,
        name,
        slot: 26,
        qpiHeader: HEADERS,
        arenaSz: 4 * 1024 * 1024,
      });
      expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
      return mine.wasm;
    };

    const nativeV1 = await buildNative("MigV1", SRC_V1);
    const nativeV2 = await buildNative("MigV2", SRC_V2);
    const oursV1 = await buildOurs("MigV1", SRC_V1);
    const oursV2 = await buildOurs("MigV2", SRC_V2);

    const run = (v1: Uint8Array, v2: Uint8Array) => {
      const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
      const user = new Uint8Array(32).fill(5);
      sim.fund(user, 1_000_000n);

      sim.deploy(26, v1);
      sim.procedure(26, 1, undefined, { invocator: user });
      sim.procedure(26, 1, undefined, { invocator: user });

      sim.deploy(26, v2);
      const migrated = sim.contracts.get(26)!.state().slice();

      sim.procedure(26, 1, undefined, { invocator: user });
      const final = sim.contracts.get(26)!.state().slice();

      return { migrated, final };
    };

    const nat = run(nativeV1, nativeV2);
    const ours = run(oursV1, oursV2);

    for (const phase of ["migrated", "final"] as const) {
      const a = nat[phase];
      const b = ours[phase];
      expect(b.length).toBe(a.length);
      const firstDiff = a.findIndex((v, i) => b[i] !== v);
      if (firstDiff >= 0) {
        console.log(
          `  ${phase} DIVERGENCE at byte ${firstDiff}: native=${a[firstDiff]} ours=${b[firstDiff]}`,
        );
      }
      expect(firstDiff).toBe(-1);
    }

    // Anchor the intended v1-to-v2 transform so matching no-ops cannot pass.
    const dv = new DataView(nat.final.buffer, nat.final.byteOffset);
    expect(dv.getBigUint64(0, true)).toBe(1030n); // total
    expect(dv.getBigUint64(8, true)).toBe(3n); // counter
    expect(dv.getBigUint64(16, true)).toBe(4n); // migratedFrom
  }, 180000);
});
