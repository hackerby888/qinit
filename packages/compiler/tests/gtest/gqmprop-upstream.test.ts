import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Runs core's own contract_gqmprop.cpp against a Qinit-compiled GeneralQuorumProposal.
//
// GQMPROP is the contract that exercises the `qpi(state.mut().proposals).setProposal(...)` proxy — a
// two-argument call whose arguments are placed by callProxy in calls/proxy.ts. A mutation sweep changed
// that placement so every parameter received argument 0, sending the originator id where the proposal
// data belongs, and nothing failed: GQMPROP's wasm changes (verified by hash), but the only test that
// touches the contract is integration/sweep.test.ts, which asserts it *builds* — which a wrong argument
// still does. GeneralQuorumProposal and ComputorControlledFund both ship with this call shape.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { buildCorpusRunner } from "@qinit/build";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";

const CORE = CORE_PATH;
const GQMPROP_IDX = 8;

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("upstream gtest — contract_gqmprop.cpp against deployed GQMPROP wasm", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "core's proposal-voting tests pass against our GeneralQuorumProposal",
        wasi,
        async () => {
            const source = readFileSync(`${CORE}/src/contracts/GeneralQuorumProposal.h`, "utf8");

            const dir = mkdtempSync(join(tmpdir(), "gqmprop-upstream-"));
            let runner: Uint8Array;
            try {
                const built = await buildCorpusRunner({
                    corpusPath: `${CORE}/test/contract_gqmprop.cpp`,
                    contractPath: `${CORE}/src/contracts/GeneralQuorumProposal.h`,
                    contractName: "GQMPROP",
                    stateType: "GQMPROP",
                    slot: GQMPROP_IDX,
                    corePath: CORE,
                    outDir: dir,
                    arenaSizeBytes: 8 * 1024 * 1024,
                });
                if (!built.ok || !built.wasmPath) {
                    throw new Error("gqmprop runner build failed:\n" + (built.stderr ?? ""));
                }
                runner = new Uint8Array(readFileSync(built.wasmPath));
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }

            const mine = await compileContractWithTypeScript({
                source,
                contractName: "GQMPROP",
                slot: GQMPROP_IDX,
                qpiHeader: loadQpiHeader(CORE),
                arenaSizeBytes: 8 * 1024 * 1024,
            });
            expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const results: TestResult[] = await runContractTesting(runner, { [GQMPROP_IDX]: mine.wasm });
            const passed = results.filter((r) => r.passed).length;
            console.log(`\n  contract_gqmprop.cpp: ${passed} PASS · ${results.length - passed} FAIL (of ${results.length})`);
            for (const r of results.filter((r) => !r.passed).slice(0, 12)) {
                console.log(`  FAIL  ${r.name || ""} — ${r.message.replace(/\n/g, " ").slice(0, 110)}`);
            }

            expect(results.length).toBeGreaterThan(0);
            expect(results.every((r) => r.passed)).toBe(true);
        },
        600000,
    );
});
