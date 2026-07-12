import { CORE_PATH } from "../../../test-utils/paths";
// u128 differential-gate over pinned seeds from `tools/fuzz-gen-u128.ts`.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";
import { generate, encodeInput } from "../tools/fuzz-gen-u128";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const PINNED: Record<number, string> = {
  1: "f001e39c3066f64700000000000000000000000000000000000000001f30ce0945ef15151dcfdc0c000000000000000000000000000000000000000000000000",
  2: "8f6b48e8a35d732501000000000000007899e7c9fda0b743bc8e1c0000000000000000000000000000000000000000007899e7c9fda0b743bc8e1c0000000000",
  3: "010040de0f89109c0d6be030099c5969f744b5b5ecec5823000000000000000000000000000000000000000000000000fefffffffffffffffeffffffffffffff",
  4: "000a406d422611c500dfd26feaee11e53b248e7d048cf76bffffffff000000000000000000000000f01f00000000000000000000000000000000000000000000",
  5: "19a2474b6a21929a1f1c8f485a4db367000000000000000000000000000000000000000000000080ffffffffffffff7f0000000000000000c8442ce7941c6522",
  6: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  7: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  8: "7c6a1b1c51093ccb0000000000000000979dfccba8a6eb660000000000000000feffffffffffffff000000000000000000000000000000000000000000000000",
  9: "feffffffffffffff0700008000000000e3f39b01b87bfc11feffffffffffffff0100000000000000000000000000000000000000000000000000000000000000",
  10: "ff01000000000000fefaf8efffffffff000000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000",
  12: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  15: "0000008000000000000000000000000000000000000000000000000000000000ff00000002000000010000000000000000000000000000000000000000000000",
  18: "0000000000000000000000000000000000000002000000000000000200000000ffffffffffffffff020000000000000000000000000000000000000000000000",
  22: "00000000000000000000000000000000a1b7686044cea54f00000000000000000000000000000000000000000000000000000000000000000000000000000000",
  25: "0000000000000000280a0a11cbe4cb04000000000000000000000000000000000000000000000000000000000000000001000000000000002e4a6351085bb3a0",
  30: "feffffffffffffff00000000000000800000000000000080b36b8065eaaea95d01000000000000000000000000000000feffffffffffffffffffffffffffff7f",
  35: "48c1854c9f5a8ed7fcffffffffffffff00000000000000000000000000000000000000311a3cf26f010000000000000000000000000000000000000000000000",
  40: "0000000000000000000000000000000000000000000000000000000000000000000000000000000017b242b100b3b49500000000000000000000000000000000",
  45: "0000000000000000000000000000000000000000000000007cc49d1abebce255da3874700ff0ded2da3874700ff0ded200000000000000000000000000000000",
  50: "000000000000000000000000000000001cb8524cd742998e61bc3a5ced13537b00000000000000000000000000000000c57edb6d2aea4a550000000000000000",
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

describe("fuzz pinned uint128 seeds", () => {
  beforeAll(async () => {
    await initK12();
  });

  for (const [seedStr, expected] of Object.entries(PINNED)) {
    const seed = Number(seedStr);
    test(`seed ${seed}`, async () => {
      const c = generate(seed);
      const ours = await compileContract({ source: c.source, name: `U${seed}`, slot: 27, qpiHeader: HEADERS, arenaSz: 1 << 20 });
      expect(ours.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
      expect(runState(ours.wasm, c.inputs)).toBe(expected);

      if (wasiOk) {
        const dir = mkdtempSync(join(tmpdir(), `fuzzpin128-${seed}-`));
        try {
          writeFileSync(join(dir, "U.h"), c.source);
          const built = await buildContract({ contractPath: join(dir, "U.h"), name: "U", slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
          expect(built.ok).toBe(true);
          expect(runState(new Uint8Array(readFileSync(built.so!)), c.inputs)).toBe(expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }, 180000);
  }
});
