// Core headers that predate the cheatcodes declare no `cheat` import. The module still has to encode,
// and a contract that does use a cheatcode has to be told why rather than shown a dangling WAT call.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileContractWithTypeScript, DiagnosticSeverity, loadQpiHeader } from "../../src/index";
import type { ParserDiagnostic } from "../../src/frontend/parser/parser-context";
import { emitForwarders } from "../../src/backend/wasm/framework/forwarders";
import { HAS_CORE, qpiHeaderWithoutCheatImport } from "../../../../test-utils/paths";

const CONTEXT_LAYOUT = { contractIndex: 0 } as Parameters<typeof emitForwarders>[0];

function errorsOf(diagnostics: readonly ParserDiagnostic[]): string[] {
    return diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message);
}

test("the cheat forwarder follows the resolved ABI, not the compiler's own wishes", () => {
    expect(emitForwarders(CONTEXT_LAYOUT, {})).not.toInclude("$lh_cheat");
    expect(emitForwarders(CONTEXT_LAYOUT)).toInclude("$lh_cheat");
});

test.if(HAS_CORE)("a contract with no cheatcode still compiles against headers that lack the import", async () => {
    const source = `
struct Plain : public ContractBase
{
    struct StateData { uint64 counter; };
    struct Inc_input {};
    struct Inc_output { uint64 value; };

    PUBLIC_PROCEDURE(Inc)
    {
        state.mut().counter += 1;
        output.value = state.get().counter;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Inc, 1); }
};`;

    const compiled = await compileContractWithTypeScript({ source, contractName: "Plain", slot: 29, qpiHeader: qpiHeaderWithoutCheatImport(loadQpiHeader()) });

    expect(errorsOf(compiled.diagnostics)).toEqual([]);
    expect(compiled.wasm.length).toBeGreaterThan(0);
});

test.if(HAS_CORE)("a CC_PRINT against those headers names the fix instead of failing in the WAT", async () => {
    const source = readFileSync(join(import.meta.dir, "../../../../fixtures/Cheats.h"), "utf8");
    const compiled = await compileContractWithTypeScript({ source, contractName: "Cheats", slot: 28, qpiHeader: qpiHeaderWithoutCheatImport(loadQpiHeader()) });
    const errors = errorsOf(compiled.diagnostics);

    // One per CC_PRINT and none for the CC_ASSERT between them: the check is on the two intrinsics
    // that lower to the import, not on every CC_ macro.
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("qinit setup");
    // The reader is pointed at their own CC_PRINT, not at generated WAT.
    expect(errors.join("\n")).not.toContain("$lh_cheat");
});
