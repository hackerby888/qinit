import { CORE_PATH } from "../../../test-utils/paths";
// Differential fuzzer for the `uint128` grammar.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";
import { generate, encodeInput, type FuzzContract } from "./fuzz-gen-u128";

const CORE = CORE_PATH;
const FINDINGS_DIR = join(import.meta.dir, "fuzz-findings-u128");

interface Finding {
  seed: number;
  kind: "ours-compile-error" | "ours-runtime-error" | "native-build-fail" | "native-runtime-error" | "state-mismatch";
  detail: string;
  ours?: string;
  native?: string;
  firstDiff?: number;
  inputs: string[][];
}

function runState(wasm: Uint8Array, c: FuzzContract): string {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(27, wasm);

  for (const row of c.inputs) {
    sim.procedure(27, 1, encodeInput(row), { invocator: user });
  }

  const st = sim.contracts.get(27)!.state();
  return Buffer.from(st.slice(0, 64)).toString("hex");
}

async function checkSeed(c: FuzzContract, headers: string, wasi: boolean): Promise<Finding | null> {
  const inputs = c.inputs.map((row) => row.map((v) => "0x" + v.toString(16)));

  let oursHex: string;
  try {
    const ours = await compileContract({ source: c.source, name: `U${c.seed}`, slot: 27, qpiHeader: headers, arenaSz: 1 << 20 });
    const errs = ours.diagnostics.filter((d) => d.severity === "error");
    if (errs.length > 0) {
      return { seed: c.seed, kind: "ours-compile-error", detail: errs.map((e) => e.message).join(" | "), inputs };
    }
    oursHex = runState(ours.wasm, c);
  } catch (e) {
    return { seed: c.seed, kind: "ours-runtime-error", detail: (e as Error).message, inputs };
  }

  if (!wasi) {
    return null;
  }

  const dir = mkdtempSync(join(tmpdir(), `fuzz128-${c.seed}-`));
  try {
    writeFileSync(join(dir, "U.h"), c.source);
    const built = await buildContract({ contractPath: join(dir, "U.h"), name: "U", slot: 27, corePath: CORE, outDir: dir, skipVerify: true });
    if (!built.ok) {
      return { seed: c.seed, kind: "native-build-fail", detail: built.stderr ?? "unknown", ours: oursHex, inputs };
    }

    let nativeHex: string;
    try {
      nativeHex = runState(new Uint8Array(readFileSync(built.so!)), c);
    } catch (e) {
      return { seed: c.seed, kind: "native-runtime-error", detail: (e as Error).message, ours: oursHex, inputs };
    }

    if (nativeHex !== oursHex) {
      let firstDiff = 0;
      while (firstDiff < 64 && oursHex.slice(firstDiff * 2, firstDiff * 2 + 2) === nativeHex.slice(firstDiff * 2, firstDiff * 2 + 2)) {
        firstDiff++;
      }
      return { seed: c.seed, kind: "state-mismatch", detail: `state differs from byte ${firstDiff} (field f${firstDiff >> 3})`, ours: oursHex, native: nativeHex, firstDiff, inputs };
    }

    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const count = Number(positional[0] ?? 100);
const startSeed = Number(positional[1] ?? 1);
const jobsArg = argv.indexOf("--jobs");
const jobs = jobsArg >= 0 ? Number(argv[jobsArg + 1]) : 4;
const oursOnly = argv.includes("--ours-only");

const wasi = !oursOnly && (() => {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
})();

await initK12();
const headers = loadQpiHeader(CORE);
mkdirSync(FINDINGS_DIR, { recursive: true });

const seeds = Array.from({ length: count }, (_, i) => startSeed + i);
const findings: Finding[] = [];
let done = 0;
let cursor = 0;
const t0 = performance.now();

async function worker(): Promise<void> {
  while (cursor < seeds.length) {
    const seed = seeds[cursor++];
    const c = generate(seed);
    const f = await checkSeed(c, headers, wasi);

    if (f) {
      findings.push(f);
      writeFileSync(join(FINDINGS_DIR, `seed-${seed}.json`), JSON.stringify(f, null, 2));
      writeFileSync(join(FINDINGS_DIR, `seed-${seed}.h`), c.source);
      console.log(`seed ${seed}: ${f.kind} — ${f.detail.slice(0, 120)}`);
    }

    done++;
    if (done % 25 === 0) {
      const rate = done / ((performance.now() - t0) / 1000);
      console.log(`[${done}/${count}] ${findings.length} findings, ${rate.toFixed(1)} seeds/s`);
    }
  }
}

await Promise.all(Array.from({ length: jobs }, worker));

const secs = ((performance.now() - t0) / 1000).toFixed(1);
const byKind = new Map<string, number>();
for (const f of findings) {
  byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
}
console.log(`\nseeds ${startSeed}..${startSeed + count - 1}: ${count - findings.length} clean, ${findings.length} findings in ${secs}s (native: ${wasi ? "on" : "off"})`);
for (const [kind, n] of byKind) {
  console.log(`  ${kind}: ${n}`);
}
process.exit(findings.length > 0 ? 1 : 0);
