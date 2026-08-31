// The proof that stripping is safe, in two halves. Stating only the second would be a tautology: a
// no-op shim erases a *missed* cheat too, so byte-equality alone proves nothing about coverage.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripCheatcodes } from "@qinit/compiler/analyzer";
import { CheatMode, compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { HAS_CORE } from "../../../../test-utils/paths";

const SOURCE = readFileSync(join(import.meta.dir, "../../../../fixtures/Cheats.h"), "utf8");

test.if(HAS_CORE)("stripped source compiles with no shim at all, and matches the neutered build byte for byte", async () => {
    const qpiHeader = loadQpiHeader();
    const options = { contractName: "Cheats", slot: 28, qpiHeader };

    // Half one: with no shim, a cheat the stripper missed is an undeclared identifier. This is what
    // Core does, so a clean compile here is what proves nothing was left behind.
    const stripped = await compileContractWithTypeScript({ ...options, source: stripCheatcodes(SOURCE), cheats: CheatMode.OFF });

    expect(stripped.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    // Half two: the same contract built with the cheats defined away. Equal bytes prove the strip
    // removed only cheat text and perturbed nothing else.
    const neutered = await compileContractWithTypeScript({ ...options, source: SOURCE, cheats: CheatMode.NOOP });

    expect(Buffer.from(stripped.wasm).equals(Buffer.from(neutered.wasm))).toBe(true);
});

test.if(HAS_CORE)("a cheat left behind fails the no-shim build, which is what makes half one meaningful", async () => {
    const result = await compileContractWithTypeScript({
        source: SOURCE,
        contractName: "Cheats",
        slot: 28,
        qpiHeader: loadQpiHeader(),
        cheats: CheatMode.OFF,
    });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length).toBeGreaterThan(0);
});
