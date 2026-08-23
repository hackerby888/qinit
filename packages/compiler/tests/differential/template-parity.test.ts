// User-declared templates, built by both compilers from the same source. Every fixture makes an
// instantiation compute something its uint64 twin would not, so a body that drops T's width or
// signedness answers wrong rather than crashing.
import { beforeAll, describe, expect } from "bun:test";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { PARITY_ARENA_BYTES, PARITY_SLOT, clangState, runState } from "../support/parity-runner";
import { CASES } from "../support/template-fixtures";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("template lowering matches Clang on the same source", () => {
    beforeAll(initK12);

    for (const templateCase of CASES) {
        toolchainTest(templateCase.name, wasi, async () => {
            const mine = await compileContractWithTypeScript({
                source: templateCase.source,
                contractName: templateCase.name,
                slot: PARITY_SLOT,
                qpiHeader: loadQpiHeader(CORE_PATH),
                arenaSizeBytes: PARITY_ARENA_BYTES,
            });
            expect(mine.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const ours = runState(mine.wasm);
            const theirs = await clangState(templateCase.name, templateCase.source, "template-parity");

            // Parity is the claim; the pinned value says which answer both are expected to reach.
            expect(ours).toBe(theirs);
            expect(ours).toBe(templateCase.expected);
        });
    }
});
