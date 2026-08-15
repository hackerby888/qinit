// Runs the QUTIL corpus against TypeScript and Clang contracts through one runner.
import { describe, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { CORE, buildRunner, buildContractsWithTypeScript, buildContractsWithClang, runUpstream, type TR } from "../support/qutil-bridge";
import { toolchainTest, wasiToolchain, type ToolchainStatus } from "../support/container-toolchains";

// The dual differential needs the wasi toolchain and an explicit opt-in, so both gate the skip.
const dual: ToolchainStatus = process.env.GTEST_DUAL ? wasiToolchain() : { available: false, detail: "set GTEST_DUAL=1 to run the dual differential" };

function classify(typescript: TR | undefined, clang: TR | undefined): string {
    const typescriptPassed = typescript?.passed ?? false;
    const clangPassed = clang?.passed ?? false;
    if (typescriptPassed && clangPassed) {
        return "ok";
    }
    if (!typescriptPassed && clangPassed) {
        return "COMPILER";
    }
    if (!typescriptPassed && !clangPassed) {
        return "BRIDGE";
    }
    return "SUSPECT";
}

describe("dual-backend differential — TypeScript vs Clang", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "TypeScript matches Clang per test",
        dual,
        async () => {
            const runner = await buildRunner(CORE);
            const clangResults = await runUpstream(runner, await buildContractsWithClang(CORE));
            const typescriptResults = await runUpstream(runner, await buildContractsWithTypeScript(CORE));

            const byName = (rs: TR[]) => new Map(rs.map((r, i) => [r.name || String(i), r]));
            const typescriptByName = byName(typescriptResults);
            const clangByName = byName(clangResults);
            const names = [...new Set([...typescriptByName.keys(), ...clangByName.keys()])];

            const buckets: Record<string, string[]> = {
                ok: [],
                COMPILER: [],
                BRIDGE: [],
                SUSPECT: [],
            };
            for (const name of names) {
                buckets[classify(typescriptByName.get(name), clangByName.get(name))].push(name);
            }

            console.log(
                `\n  dual: ${buckets.ok.length} ok · ${buckets.COMPILER.length} COMPILER-BUG · ${buckets.BRIDGE.length} BRIDGE-BUG · ${buckets.SUSPECT.length} SUSPECT (of ${names.length})`,
            );
            for (const name of buckets.COMPILER) {
                console.log(`  COMPILER  ${name} — TypeScript fails, Clang passes (fix codegen)`);
            }
            const bridgeHint = "Clang fails (fix ContractTesting bridge/simulator)";
            for (const name of buckets.BRIDGE) {
                console.log(`  BRIDGE    ${name} — ${bridgeHint}`);
            }
            const suspectHint = "TypeScript passes, Clang fails (investigate the oracle)";
            for (const name of buckets.SUSPECT) {
                console.log(`  SUSPECT   ${name} — ${suspectHint}`);
            }

            const typescriptVector = names.map((name) => `${name}:${typescriptByName.get(name)?.passed ? 1 : 0}`);
            const clangVector = names.map((name) => `${name}:${clangByName.get(name)?.passed ? 1 : 0}`);
            expect(typescriptVector).toEqual(clangVector);
        },
        600000,
    );
});
