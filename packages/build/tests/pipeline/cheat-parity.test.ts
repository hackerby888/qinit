// The two backends carry cheatcodes through completely different machinery: the TypeScript compiler
// lowers CC_PRINT with an intrinsic, clang expands a parameter pack. This is the test that says they
// agree — same source in, same (id, part, bytes) on the wire.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/engine/support/k12";
import { CORE_PATH, HAS_CORE, HAS_WASI } from "../../../../test-utils/paths";
import { buildContractWithClang } from "../../src/compile/pipeline";
import { buildContractWithTypeScript } from "../../src/compile/typescript";

const CONTRACT = join(import.meta.dir, "../../../../fixtures/Cheats.h");
const ADD = 1;

interface CheatRecord {
    id: number;
    part: number;
    size: number;
    hex: string;
}

async function cheatsFrom(wasmPath: string): Promise<CheatRecord[]> {
    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, new Uint8Array(readFileSync(wasmPath)));
    sim.procedure(28, ADD, new Uint8Array(new BigUint64Array([7n]).buffer));

    return sim.getTrace().entries.at(-1)!.cheats.map(({ id, part, size, hex }) => ({ id, part, size, hex }));
}

test.if(HAS_CORE && HAS_WASI)("clang and the TypeScript backend put the same cheat records on the wire", async () => {
    const options = { contractPath: CONTRACT, contractName: "Cheats", slot: 28, corePath: CORE_PATH };
    const clang = await buildContractWithClang({ ...options, outDir: mkdtempSync(join(tmpdir(), "qinit-cheat-clang-")) });
    const typescript = await buildContractWithTypeScript({ ...options, outDir: mkdtempSync(join(tmpdir(), "qinit-cheat-ts-")) });

    expect(clang.ok, clang.stderr).toBe(true);
    expect(typescript.ok, typescript.stderr).toBe(true);

    const [fromClang, fromTypeScript] = await Promise.all([cheatsFrom(clang.wasmPath!), cheatsFrom(typescript.wasmPath!)]);

    expect(fromClang.length).toBeGreaterThan(0);
    expect(fromClang).toEqual(fromTypeScript);
});
