// The proof that stripping is safe, in two halves. Stating only the second would be a tautology: a
// no-op shim erases a *missed* cheat too, so byte-equality alone proves nothing about coverage.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripCheatcodes } from "@qinit/compiler/analyzer";
import { CheatMode, compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { HAS_CORE } from "../../../../test-utils/paths";

const FIXTURES = join(import.meta.dir, "../../../../fixtures");

// Every cheat fixture: the one that only prints, every print shape, and every mutating macro.
const CONTRACTS = ["Cheats", "CheatShapes", "CheatOps"];

function sourceOf(contractName: string): string {
    return readFileSync(join(FIXTURES, `${contractName}.h`), "utf8");
}

for (const contractName of CONTRACTS) {
    test.if(HAS_CORE)(`stripped ${contractName} compiles with no shim at all, and matches the neutered build byte for byte`, async () => {
        const source = sourceOf(contractName);
        const options = { contractName, slot: 28, qpiHeader: loadQpiHeader() };

        // Half one: with no shim, a cheat the stripper missed is an undeclared identifier. This is what
        // Core does, so a clean compile here is what proves nothing was left behind.
        const stripped = await compileContractWithTypeScript({ ...options, source: stripCheatcodes(source), cheats: CheatMode.OFF });

        expect(stripped.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

        // Half two: the same contract built with the cheats defined away. Equal bytes prove the strip
        // removed only cheat text and perturbed nothing else.
        const neutered = await compileContractWithTypeScript({ ...options, source, cheats: CheatMode.NOOP });

        expect(Buffer.from(stripped.wasm).equals(Buffer.from(neutered.wasm))).toBe(true);
    });
}

test.if(HAS_CORE)("a cheat left behind fails the no-shim build, which is what makes half one meaningful", async () => {
    const result = await compileContractWithTypeScript({
        source: sourceOf("Cheats"),
        contractName: "Cheats",
        slot: 28,
        qpiHeader: loadQpiHeader(),
        cheats: CheatMode.OFF,
    });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length).toBeGreaterThan(0);
});
