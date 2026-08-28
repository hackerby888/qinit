import { afterAll, beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { CORE_PATH } from "../../../../test-utils/paths";
import { loadQpiHeader } from "../../src/index";
import { CONTAINER_FIXTURES } from "../support/container-fixtures";
import {
    CONTAINER_SLOT,
    compareExecutions,
    compileClangFixture,
    compileTsFixture,
    executeContainerScript,
    executeWamr,
    seededOperations,
} from "../support/container-harness";
import { toolchainTest, wamrToolchain, wasiToolchain } from "../support/container-toolchains";

// On by default: the toolchain probes below already skip each test whose compiler or runtime is absent,
// so this only ever needs to be turned off deliberately (QINIT_CONTAINER_PARITY=0). It ran as a
// permanent skip for as long as the WAMR probe missed core-lite's build-wasm directory.
const ENABLED = process.env.QINIT_CONTAINER_PARITY !== "0";
const SEEDS = Number(process.env.QINIT_CONTAINER_SEEDS ?? 4);
const SEED_START = Number(process.env.QINIT_CONTAINER_SEED_START ?? 0);
const SEED_END = SEED_START + SEEDS - 1;
const OPERATIONS = Number(process.env.QINIT_CONTAINER_OPERATIONS ?? 64);
const TEST_TITLE = `container parity (seeds ${SEED_START}..${SEED_END} x ${OPERATIONS} operations)`;
const TS = new Map<string, Uint8Array>();
const CLANG = new Map<string, Uint8Array>();
const disposers: Array<() => void> = [];
const wasi = wasiToolchain();
const wamr = wamrToolchain(CORE_PATH);
const matrix = {
    available: wasi.available && wamr.available,
    detail: `WASI: ${wasi.detail}; WAMR: ${wamr.detail}`,
    path: wamr.path,
};

beforeAll(async () => {
    if (!ENABLED) return;
    await initK12();
    const header = loadQpiHeader(CORE_PATH);
    for (const fixture of CONTAINER_FIXTURES) {
        TS.set(fixture.family, await compileTsFixture(fixture, header));
        if (wasi.available) {
            const clangBuild = await compileClangFixture(fixture, CORE_PATH);
            CLANG.set(fixture.family, clangBuild.wasm);
            disposers.push(clangBuild.dispose);
        }
    }
}, 600_000);

afterAll(() => {
    for (const dispose of disposers) dispose();
});

describe.skipIf(!ENABLED)(TEST_TITLE, () => {
    for (const fixture of CONTAINER_FIXTURES) {
        toolchainTest(
            `${fixture.family}: TypeScript matches Clang/WASI outputs, boundary checkpoints, and complete state`,
            wasi,
            () => {
                const tsWasm = TS.get(fixture.family)!;
                const clangWasm = CLANG.get(fixture.family)!;
                const boundaryMismatch = compareExecutions(
                    executeContainerScript(tsWasm, fixture.boundary, true),
                    executeContainerScript(clangWasm, fixture.boundary, true),
                );
                expect(boundaryMismatch, `${fixture.family} boundary matrix: ${boundaryMismatch}`).toBeNull();
                for (let seedOffset = 0; seedOffset < SEEDS; seedOffset++) {
                    const seed = SEED_START + seedOffset;
                    const operations = seededOperations(fixture.family, seed, OPERATIONS);
                    const mismatch = compareExecutions(executeContainerScript(tsWasm, operations), executeContainerScript(clangWasm, operations));
                    expect(mismatch, `${fixture.family} seed ${seed}: ${mismatch}`).toBeNull();
                }
            },
            600_000,
        );

        toolchainTest(
            `${fixture.family}: all compiler/runtime paths match Clang Wasm in core-lite WAMR`,
            matrix,
            () => {
                const artifacts = [
                    ["TS", TS.get(fixture.family)!],
                    ["Clang", CLANG.get(fixture.family)!],
                ] as const;
                const scripts = [
                    ["boundary", fixture.boundary],
                    ...Array.from({ length: SEEDS }, (_, seedOffset) => {
                        const seed = SEED_START + seedOffset;
                        return [`seed ${seed}`, seededOperations(fixture.family, seed, OPERATIONS)] as const;
                    }),
                ] as const;
                for (const [scriptName, operations] of scripts) {
                    const captureCheckpoints = scriptName === "boundary";
                    const oracle = executeWamr(wamr.path!, artifacts[1][1], operations, CONTAINER_SLOT, captureCheckpoints);
                    for (const [compiler, artifact] of artifacts) {
                        const paths = [
                            [`${compiler} Wasm -> QubicSimulator`, executeContainerScript(artifact, operations, captureCheckpoints)],
                            [`${compiler} Wasm -> WAMR`, executeWamr(wamr.path!, artifact, operations, CONTAINER_SLOT, captureCheckpoints)],
                        ] as const;
                        for (const [pathName, result] of paths) {
                            const mismatch = compareExecutions(result, oracle);
                            expect(mismatch, `${fixture.family} ${scriptName} ${pathName}: ${mismatch}`).toBeNull();
                        }
                    }
                }
            },
            600_000,
        );
    }

    toolchainTest(
        "raw WAMR parity rejects an artifact compiled for a different slot",
        matrix,
        () => {
            const fixture = CONTAINER_FIXTURES[0];
            expect(() => executeWamr(wamr.path!, TS.get(fixture.family)!, fixture.boundary, 28)).toThrow("artifact slot mismatch");
        },
        120_000,
    );
});
