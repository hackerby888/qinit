import { CORE_PATH } from "../../../test-utils/paths";
// Regenerates pinned seeds for `tests/fuzz/fuzz-u128.test.ts`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { bytesToHex, initK12 } from "@qinit/core";
import { compileContractWithTypeScript, DiagnosticSeverity, loadQpiHeader } from "../src/index";
import { generate, encodeInput } from "./fuzz-gen-u128";

const CORE = CORE_PATH;
const H = loadQpiHeader(CORE);
await initK12();

function runState(wasm: Uint8Array, inputs: bigint[][]): string {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, wasm);
    for (const row of inputs) {
        sim.procedure(27, 1, encodeInput(row), { invocator: user });
    }
    const st = sim.contracts.get(27)!.state();
    return bytesToHex(st.slice(0, 64));
}

for (const seed of process.argv.slice(2).map(Number)) {
    const c = generate(seed);
    const ours = await compileContractWithTypeScript({
        source: c.source,
        contractName: `U${seed}`,
        slot: 27,
        qpiHeader: H,
        arenaSizeBytes: 1 << 20,
    });
    if (ours.diagnostics.some((d) => d.severity === DiagnosticSeverity.ERROR)) {
        console.log(`  // seed ${seed}: OURS COMPILE FAIL — not pinned`);
        continue;
    }
    const oursHex = runState(ours.wasm, c.inputs);

    const dir = mkdtempSync(join(tmpdir(), `pin128-${seed}-`));
    try {
        writeFileSync(join(dir, "U.h"), c.source);
        const built = await buildContractWithClang({
            contractPath: join(dir, "U.h"),
            contractName: "U",
            slot: 27,
            corePath: CORE,
            outDir: dir,
            skipVerify: true,
        });
        if (!built.ok) {
            console.log(`  // seed ${seed}: NATIVE BUILD FAIL — not pinned`);
            continue;
        }
        const nativeHex = runState(new Uint8Array(readFileSync(built.wasmPath!)), c.inputs);
        if (nativeHex !== oursHex) {
            console.log(`  // seed ${seed}: DIVERGES — not pinned`);
            continue;
        }
        console.log(`  ${seed}: "${oursHex}",`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
