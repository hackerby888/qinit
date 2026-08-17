import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileContractWithTypeScript, DiagnosticSeverity, type CompileDiagnostic, type CompileResult } from "../../src/index";
import { CORE_PATH, HAS_CORE, QINIT_ROOT } from "../../../../test-utils/paths";

const SOURCE = readFileSync(join(QINIT_ROOT, "fixtures", "Counter.h"), "utf8");

// The exported diagnostic name must be the element type of the field it describes.
test("CompileDiagnostic is what CompileResult.diagnostics holds", () => {
    const sample: CompileDiagnostic = { severity: DiagnosticSeverity.WARNING, message: "x", span: { start: 0, end: 0, line: 1, column: 1 } };
    const asFieldElement: CompileResult["diagnostics"][number] = sample;

    expect(asFieldElement.severity).toBe(DiagnosticSeverity.WARNING);
});

test.skipIf(!HAS_CORE)("the entry accepts a contract path and a core path, not just text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-entry-options-"));
    const contractPath = join(directory, "Counter.h");
    writeFileSync(contractPath, SOURCE);

    try {
        const fromPath = await compileContractWithTypeScript({ contractPath, contractName: "Counter", slot: 28, corePath: CORE_PATH });
        const fromText = await compileContractWithTypeScript({ source: SOURCE, contractName: "Counter", slot: 28, corePath: CORE_PATH });

        expect(fromPath.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        expect(fromPath.wasm.byteLength).toBeGreaterThan(0);
        expect(fromPath.wasm).toEqual(fromText.wasm);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}, 120_000);

test.skipIf(!HAS_CORE)("the entry reports a missing source instead of compiling nothing", async () => {
    await expect(compileContractWithTypeScript({ contractName: "Counter", slot: 28, corePath: CORE_PATH })).rejects.toThrow(
        "either `source` or `contractPath`",
    );
});
