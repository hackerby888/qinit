// Inheritance, built by both compilers from the same source. A derived class shares its base's
// fields, methods and operators, and constructs the base before its own body runs.
import { beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { PARITY_ARENA_BYTES, PARITY_SLOT, clangState, runState } from "../support/parity-runner";
import { CASES } from "../support/inheritance-fixtures";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("inheritance matches Clang on the same source", () => {
    beforeAll(initK12);

    for (const inheritanceCase of CASES) {
        toolchainTest(inheritanceCase.name, wasi, async () => {
            const mine = await compileContractWithTypeScript({
                source: inheritanceCase.source,
                contractName: inheritanceCase.name,
                slot: PARITY_SLOT,
                qpiHeader: loadQpiHeader(CORE_PATH),
                arenaSizeBytes: PARITY_ARENA_BYTES,
            });
            expect(mine.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const ours = runState(mine.wasm);
            const theirs = await clangState(inheritanceCase.name, inheritanceCase.source, "inheritance-parity");

            // Parity is the claim; the pinned value says which answer both are expected to reach.
            expect(ours).toBe(theirs);
            expect(ours).toBe(inheritanceCase.expected);
        });
    }
});
