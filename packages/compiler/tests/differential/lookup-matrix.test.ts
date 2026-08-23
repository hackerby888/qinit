// Shapes that leave a class without an entry of its own, crossed with the operations that consult one.
// Clang answers each cell, so no expectation here is arithmetic anyone did by hand.
import { beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { PARITY_ARENA_BYTES, PARITY_SLOT, clangState, runState } from "../support/parity-runner";
import { OPERATIONS, SHAPES, matrixSource } from "../support/lookup-matrix";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("a lookup answers for every class shape", () => {
    beforeAll(initK12);

    for (const shape of SHAPES) {
        for (const operation of OPERATIONS.filter((candidate) => shape.operations.includes(candidate.key))) {
            toolchainTest(`${shape.key} / ${operation.key}`, wasi, async () => {
                const source = matrixSource(shape, operation);
                const name = `Matrix_${shape.key.replaceAll("-", "")}_${operation.key.replaceAll("-", "")}`;

                const mine = await compileContractWithTypeScript({
                    source,
                    contractName: name,
                    slot: PARITY_SLOT,
                    qpiHeader: loadQpiHeader(CORE_PATH),
                    arenaSizeBytes: PARITY_ARENA_BYTES,
                });
                expect(mine.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

                expect(runState(mine.wasm)).toBe(await clangState(name, source, "lookup-matrix"));
            });
        }
    }
});
