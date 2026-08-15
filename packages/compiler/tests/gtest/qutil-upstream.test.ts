// Runs the upstream QUTIL gtest corpus against deployable contracts in QubicSimulator.
import { describe, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import {
    CORE,
    buildRunner,
    buildContractsWithTypeScript,
    buildContractsWithClang,
    runUpstream,
} from "../support/qutil-bridge";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";

const wasi = wasiToolchain();

describe("upstream gtest — contract_qutil.cpp against deployed QUTIL+QX wasm", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "contract_qutil.cpp drives the selected backend",
        wasi,
        async () => {
            const compiler = (process.env.GTEST_COMPILER ?? "typescript") as "typescript" | "clang";
            if (compiler !== "typescript" && compiler !== "clang") {
                throw new Error(
                    `GTEST_COMPILER must be "typescript" or "clang", got "${compiler}"`,
                );
            }
            const runner = await buildRunner(CORE);
            const contracts =
                compiler === "clang"
                    ? await buildContractsWithClang(CORE)
                    : await buildContractsWithTypeScript(CORE);
            const results = await runUpstream(runner, contracts);

            const passed = results.filter((r) => r.passed).length;
            const failed = results.length - passed;
            console.log(
                `\n  [${compiler}] contract_qutil.cpp: ${passed} PASS · ${failed} FAIL (of ${results.length})`,
            );
            for (const r of results.filter((r) => !r.passed).slice(0, 12)) {
                const detail = r.message.replace(/\n/g, " ").slice(0, 110);
                console.log(`  FAIL  ${r.name || ""} — ${detail}`);
            }
            expect(passed).toBeGreaterThanOrEqual(51);
        },
        300000,
    );
});
