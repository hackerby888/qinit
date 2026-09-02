// The two backends carry cheatcodes through completely different machinery: the TypeScript compiler
// lowers CC_PRINT with an intrinsic, clang expands a parameter pack. This is the test that says they
// agree — same source in, same (id, part, bytes) on the wire, for every argument shape a print accepts.
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

const FIXTURES = join(import.meta.dir, "../../../../fixtures");

interface CheatRecord {
    id: number;
    part: number;
    size: number;
    value: string;
    hex: string;
}

interface Fixture {
    contractName: string;
    drive: (sim: QubicSimulator) => void;
}

// Put_input { ABC abc; sint32 neg; bit flag; }: a = 5, b = 7, neg = -3, flag set.
function putInput(): Uint8Array {
    const input = new Uint8Array(24);
    const view = new DataView(input.buffer);

    view.setBigUint64(0, 5n, true);
    view.setUint16(8, 7, true);
    view.setInt32(16, -3, true);
    input[20] = 1;

    return input;
}

const FIXTURE_MATRIX: Fixture[] = [
    { contractName: "Cheats", drive: (sim) => sim.procedure(28, 1, new Uint8Array(new BigUint64Array([7n]).buffer)) },
    {
        contractName: "CheatShapes",
        drive: (sim) => {
            sim.query(28, 1);
            sim.procedure(28, 1, putInput());
        },
    },
];

async function recordsFrom(wasmPath: string, fixture: Fixture): Promise<CheatRecord[]> {
    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, new Uint8Array(readFileSync(wasmPath)));
    fixture.drive(sim);

    return sim.getTrace().entries.flatMap((entry) => entry.cheats.map(({ id, part, size, value, hex }) => ({ id, part, size, value: String(value), hex })));
}

async function buildBoth(contractName: string) {
    const options = { contractPath: join(FIXTURES, `${contractName}.h`), contractName, slot: 28, corePath: CORE_PATH };
    const clang = await buildContractWithClang({ ...options, outDir: mkdtempSync(join(tmpdir(), "qinit-cheat-clang-")) });
    const typescript = await buildContractWithTypeScript({ ...options, outDir: mkdtempSync(join(tmpdir(), "qinit-cheat-ts-")) });

    expect(clang.ok, clang.stderr).toBe(true);
    expect(typescript.ok, typescript.stderr).toBe(true);

    return { clang, typescript };
}

for (const fixture of FIXTURE_MATRIX) {
    test.if(HAS_CORE && HAS_WASI)(
        `clang and the TypeScript backend put the same cheat records on the wire for ${fixture.contractName}`,
        async () => {
            const { clang, typescript } = await buildBoth(fixture.contractName);
            const [fromClang, fromTypeScript] = await Promise.all([recordsFrom(clang.wasmPath!, fixture), recordsFrom(typescript.wasmPath!, fixture)]);

            expect(fromClang.length).toBeGreaterThan(0);
            expect(fromClang).toEqual(fromTypeScript);
        },
        120_000,
    );
}

test.if(HAS_CORE && HAS_WASI)(
    "the mutating cheatcodes compile through clang too",
    async () => {
        const clang = await buildContractWithClang({
            contractPath: join(FIXTURES, "CheatOps.h"),
            contractName: "CheatOps",
            slot: 28,
            corePath: CORE_PATH,
            outDir: mkdtempSync(join(tmpdir(), "qinit-cheat-ops-")),
        });

        expect(clang.ok, clang.stderr).toBe(true);
    },
    120_000,
);
