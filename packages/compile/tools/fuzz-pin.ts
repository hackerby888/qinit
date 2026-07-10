// Regenerates pinned seeds for `tests/fuzz-diff.test.ts`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";
import { generate, encodeInput } from "./fuzz-gen";

const CORE = "/home/kali/Projects/core-lite";
const H = loadQpiHeader(CORE);
await initK12();

function runState(wasm: Uint8Array, inputs: bigint[][]): string {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, wasm);
  for (const row of inputs) {
    sim.procedure(27, 1, encodeInput(row), { invocator: user });
  }
  const st = sim.contracts.get(27)!.state();
  return Buffer.from(st.slice(0, 64)).toString("hex");
}

for (const seed of process.argv.slice(2).map(Number)) {
  const c = generate(seed);
  const ours = await compileContract({ source: c.source, name: `F${seed}`, slot: 27, qpiHeader: H, arenaSz: 1 << 20 });
  if (ours.diagnostics.some((d) => d.severity === "error")) {
    console.log(`  // seed ${seed}: OURS COMPILE FAIL — not pinned`);
    continue;
  }
  const oursHex = runState(ours.wasm, c.inputs);

  const dir = mkdtempSync(join(tmpdir(), `pin-${seed}-`));
  try {
    writeFileSync(join(dir, "F.h"), c.source);
    const built = await buildContract({ contractPath: join(dir, "F.h"), name: "F", slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
    if (!built.ok) {
      console.log(`  // seed ${seed}: NATIVE BUILD FAIL — not pinned`);
      continue;
    }
    const nativeHex = runState(new Uint8Array(readFileSync(built.so!)), c.inputs);
    if (nativeHex !== oursHex) {
      console.log(`  // seed ${seed}: DIVERGES — not pinned`);
      continue;
    }
    console.log(`  ${seed}: "${oursHex}",`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
