import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang, buildContractWithTypeScript, type ClangBuildOptions, type TypeScriptBuildOptions } from "../../src";
import { CORE_PATH, QINIT_ROOT } from "../../../../test-utils/paths";

const SOURCE = readFileSync(join(QINIT_ROOT, "fixtures", "Counter.h"), "utf8");

// The point of the aligned field names: the same literal satisfies both backends' options types.
const shared = { contractName: "Counter", slot: 28 };

test("one options object satisfies both backends", () => {
    const options = { ...shared, source: SOURCE, corePath: "/core", outDir: "/out" };
    const asClang: ClangBuildOptions = options;
    const asTypeScript: TypeScriptBuildOptions = options;

    expect(asClang.contractName).toBe(asTypeScript.contractName);
    expect(asClang.corePath).toBe(asTypeScript.corePath);
});

test("each backend accepts source text with no contractPath", async () => {
    const corePath = CORE_PATH;
    const directory = mkdtempSync(join(tmpdir(), "qinit-backend-parity-"));

    try {
        const options = { ...shared, source: SOURCE, corePath, outDir: join(directory, "ts") };
        const typescriptBuild = await buildContractWithTypeScript(options);
        expect(typescriptBuild.stderr ?? "").not.toContain("either `contractPath` or `source`");
        expect(typescriptBuild.ok).toBe(true);

        // Clang has no in-memory path, so source text is staged as <contractName>.h before it runs.
        const clangBuild = await buildContractWithClang({ ...options, outDir: join(directory, "clang"), skipVerify: true });
        expect(clangBuild.ok).toBe(true);
        expect(readFileSync(join(directory, "clang", "Counter.h"), "utf8")).toBe(SOURCE);
        expect(clangBuild.idl?.name).toBe(typescriptBuild.idl?.name);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}, 180_000);

test("a backend given neither source nor contractPath reports it instead of throwing", async () => {
    const result = await buildContractWithClang({ ...shared, corePath: "/core", outDir: "/out", skipVerify: true });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("either `contractPath` or `source`");
});
