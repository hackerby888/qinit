// Differential-fuzzer regression gate. Each pinned seed generates a contract (tools/fuzz-gen.ts
// is pure: seed → identical source and inputs forever), runs it in the engine, and compares the
// full StateData against a recorded state that was native-verified when the pin was made — so
// the suite catches codegen regressions without needing clang. When the wasi toolchain is
// present the native build re-derives every pin, keeping the recordings honest.
//
// The pins encode the generator grammar: any change to tools/fuzz-gen.ts shifts the RNG stream
// and invalidates them. Regenerate with `bun run tools/fuzz-pin.ts <seeds...>` (it refuses to
// pin a divergent seed).
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";
import { generate, encodeInput } from "../tools/fuzz-gen";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const PINNED: Record<number, string> = {
  1: "0100000000000000ce00000000000000000000000000000006000000000000000100000000000000000000000000000000000000000000000000000000000000",
  5: "0000000000000000f56511460000000056fd000000000000010000000000000056fd000000000000010000000000000000000000000000000000000000000000",
  7: "753b7cb1cd0b9229c3ffffffffffffff010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  16: "000000000000000045ffffffffffffff1ba000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  19: "02000000000000002c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  36: "a500000000000000b9ffffffffffffff1f00000000000000000000000000000000000000000000007c000000000000001f000000000000007b00000000000000",
  38: "2e000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000",
  62: "73000000000000000000000000000000f6110000000000000100000000000000ffff000000000000ffff00000000000000000000000000000000000000000000",
  124: "000000000000000001000000000000007e000000000000008f0a0000000000008bffffffffffffff000000000000000000000000000000000000000000000000",
  151: "000000000000000000000000000000004600000000000000ffff0000000000000000000000000000000000000000000000000000000000000000000000000000",
  177: "ffffffffffffffff0000000000000000ffffffffffffffff01000000000000000000000000000000000000000000000000000000000000000000000000000000",
  185: "0000000000000000ab00000000000000000000000000000040420f00000000002a00000000000000000000000000000000000000000000000000000000000000",
  194: "01000000000000005a00000000000000000000000000000000000000000000000200000000000000010000000000000000000000000000000000000000000000",
  213: "0000000000000000010000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  237: "a105000000000000feffffffffffffff2100104209080101c69c7df500000000ffff000000000000000000000000000000000000000000000000000000000000",
  276: "ccb40c400000000001003e0000000000ffffffffffffffffccb40c40000000000000000000000000010000000000000000000000000000000000000000000000",
  331: "eb6b6377000000000000000000000000401f0000000000000100000000000000feffffffffffffffc2494d0b665987a900000000000000000000000000000000",
  404: "0000000000000000e571a6d4ffffffff0100000000000000e1ffffffffffffff0000000000000000000000000000000000000000000000000000000000000000",
  417: "6b000000000000000000000000000000000000c0dde1ff1f11f1000000000000d0f0000000000000070000000000000000000000000000000000000000000000",
  455: "28000000000000000000000000000000010000000000000005000000000000000100000000000000000000000000000000000000000000000000000000000000",
};

const runState = (wasm: Uint8Array, inputs: bigint[][]): string => {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, wasm);
  for (const row of inputs) {
    sim.procedure(27, 1, encodeInput(row), { invocator: user });
  }
  const st = sim.contracts.get(27)!.state();
  return Buffer.from(st.slice(0, 64)).toString("hex");
};

const wasiOk = (() => {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
})();

describe("fuzz pinned seeds", () => {
  beforeAll(async () => {
    await initK12();
  });

  for (const [seedStr, expected] of Object.entries(PINNED)) {
    const seed = Number(seedStr);
    test(`seed ${seed}`, async () => {
      const c = generate(seed);
      const ours = await compileContract({ source: c.source, name: `F${seed}`, slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
      expect(ours.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
      expect(runState(ours.wasm, c.inputs)).toBe(expected);

      if (wasiOk) {
        const dir = mkdtempSync(join(tmpdir(), `fuzzpin-${seed}-`));
        try {
          writeFileSync(join(dir, "F.h"), c.source);
          const built = await buildContract({ contractPath: join(dir, "F.h"), name: "F", slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
          expect(built.ok).toBe(true);
          expect(runState(new Uint8Array(readFileSync(built.so!)), c.inputs)).toBe(expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }, 180000);
  }
});
