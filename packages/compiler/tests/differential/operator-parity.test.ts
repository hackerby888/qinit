// The operator edge suite asserts what each declared body should compute. This one builds the same
// source with Clang and asserts both compilers land on the same state, so an expectation cannot be
// wrong in both places at once.
import { beforeAll, describe, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { ASSIGNING, FEE_AMOUNT, HALF_KEY, HELPER_MONEY, MONEY, wrapOperatorFixture as wrap } from "../support/operator-fixtures";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const SLOT = 27;
const ARENA_BYTES = 1 << 20;

function runState(wasm: Uint8Array): bigint {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);

    simulator.fund(user, 1_000_000n);
    simulator.deploy(SLOT, wasm);
    simulator.procedure(SLOT, 1, undefined, { invocator: user });

    const state = simulator.contracts.get(SLOT)!.state();

    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

async function clangState(name: string, source: string): Promise<bigint> {
    const directory = mkdtempSync(join(tmpdir(), `operator-parity-${name}-`));

    try {
        const contractPath = join(directory, `${name}.h`);
        writeFileSync(contractPath, source);

        const built = await buildContractWithClang({
            contractPath,
            contractName: name,
            slot: SLOT,
            corePath: CORE_PATH,
            outDir: directory,
            arenaSizeBytes: ARENA_BYTES,
            skipVerify: true,
        });
        expect(built.ok).toBe(true);

        return runState(new Uint8Array(readFileSync(built.wasmPath!)));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

interface ParityCase {
    name: string;
    source: string;
    expected: bigint;
}

const CASES: ParityCase[] = [
    {
        name: "DeclaredEquality",
        source: wrap(
            HALF_KEY,
            "HalfKey left; HalfKey right;",
            `locals.left = { 1, 2 };
       locals.right = { 1, 99 };
       state.mut().result = (locals.left == locals.right) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    {
        name: "ScalarConversion",
        source: wrap(
            FEE_AMOUNT,
            "FeeAmount bid;",
            `locals.bid = FeeAmount(5);
       state.mut().result = (locals.bid == 5) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    {
        name: "OperatorResultOperand",
        source: wrap(
            MONEY,
            "Money a; Money b;",
            `locals.a = Money(2);
       locals.b = Money(3);
       state.mut().result = ((locals.a + locals.b) == Money(5)) ? 1 : 0;`,
        ),
        expected: 1n,
    },
    {
        name: "DeclaredAssignment",
        source: wrap(
            ASSIGNING,
            "Box a; Box b;",
            `locals.a.v = 5;
       locals.b = locals.a;
       state.mut().result = locals.b.v;`,
        ),
        expected: 10n,
    },
    {
        name: "DeclaredCompoundAssignment",
        source: wrap(
            ASSIGNING,
            "Box a; Box b;",
            `locals.a.v = 5;
       locals.b.v = 1;
       locals.b += locals.a;
       state.mut().result = locals.b.v;`,
        ),
        expected: 106n,
    },
    {
        name: "HelperResultOperand",
        source: wrap(
            HELPER_MONEY,
            "Money m;",
            `locals.m = Money(5);
       state.mut().result = (makeMoney(5) == locals.m) ? 1 : 0;`,
        ),
        expected: 1n,
    },
];

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("operator lowering matches Clang on the same source", () => {
    beforeAll(initK12);

    for (const parityCase of CASES) {
        toolchainTest(
            parityCase.name,
            wasi,
            async () => {
                const mine = await compileContractWithTypeScript({
                    source: parityCase.source,
                    contractName: parityCase.name,
                    slot: SLOT,
                    qpiHeader: loadQpiHeader(CORE_PATH),
                    arenaSizeBytes: ARENA_BYTES,
                });
                expect(mine.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

                const ours = runState(mine.wasm);
                const theirs = await clangState(parityCase.name, parityCase.source);

                // Parity is the claim; the pinned value says which answer both are expected to reach.
                expect(ours).toBe(theirs);
                expect(ours).toBe(parityCase.expected);
            },
            180000,
        );
    }
});
