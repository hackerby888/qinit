// Verifies the generic ContractTesting bridge against the established QUTIL corpus.
import { describe, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { runContractTesting } from "@qinit/engine";
import { CORE, buildRunner, buildContractsWithTypeScript } from "../support/qutil-bridge";
import { HAS_CORE } from "../../../../test-utils/paths";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("runContractTesting — generic engine binding (QUTIL regression)", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "QUTIL corpus >= 51 PASS via engine runContractTesting",
        wasi,
        async () => {
            const runner = await buildRunner(CORE);
            const contracts = await buildContractsWithTypeScript(CORE);
            const results = await runContractTesting(runner, contracts);

            const passed = results.filter((r) => r.passed).length;
            const failed = results.length - passed;
            console.log(`\n  [engine] contract_qutil.cpp: ${passed} PASS · ${failed} FAIL (of ${results.length})`);
            for (const r of results.filter((r) => !r.passed).slice(0, 12)) {
                const detail = r.message.replace(/\n/g, " ").slice(0, 110);
                console.log(`  FAIL  ${r.name || ""} — ${detail}`);
            }
            expect(passed).toBeGreaterThanOrEqual(51);
        },
        300000,
    );
});
