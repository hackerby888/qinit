// F67: a nested type and a member procedure/function sharing a name — C++ hides the type behind the
// function ([basic.scope.hiding]/2), so a bare use of the type after the function is declared is an error
// clang rejects. The TypeScript backend used to resolve the type silently and emit wasm. This pins the
// accept/reject verdict to clang's, ordering and all: a use before the function is fine, a use after is not.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileContractWithTypeScript } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { buildContractWithClang } from "@qinit/build";
import { HAS_CORE, CORE_PATH } from "../../../../test-utils/paths";
import { wasiToolchain } from "../support/container-toolchains";

const contract = (peekLocals: string, peekBody: string, entryType = "Lock", stateType = "Lock"): string => `using namespace QPI;
struct NameHide2 {};
struct S : public ContractBase {
  struct ${entryType} { uint64 shares; };
  struct StateData { ${stateType} last; };
  struct Lock_input { uint64 shares; };
  struct Lock_output { uint64 result; };
  struct Lock_locals { ${stateType} l; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Lock) { locals.l.shares = input.shares; state.mut().last = locals.l; output.result = locals.l.shares; }
  struct Peek_input {};
  struct Peek_output { uint64 shares; };
  struct Peek_locals { ${peekLocals} };
  PUBLIC_FUNCTION_WITH_LOCALS(Peek) { ${peekBody} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Lock, 1); REGISTER_USER_FUNCTION(Peek, 1); }
  INITIALIZE() { state.mut().last.shares = 0; }
};`;

// The struct `Lock` is declared before the procedure `Lock`; each probe differs only in whether a bare
// `Lock` type-use appears after that procedure.
const PROBES: { name: string; source: string; reject: boolean }[] = [
    // bare `Lock` used after the procedure (Peek_locals) — the reported bug.
    { name: "use-after-procedure", source: contract("Lock l;", "locals.l = state.get().last; output.shares = locals.l.shares;"), reject: true },
    // same collision, but no bare `Lock` after the procedure — clang accepts, so we must too.
    { name: "no-use-after-procedure", source: contract("uint64 l;", "locals.l = state.get().last.shares; output.shares = locals.l;"), reject: false },
    // hidden type reached through a template argument after the procedure.
    { name: "use-after-via-template-arg", source: contract("Array<Lock, 2> l;", "locals.l.set(0, state.get().last); output.shares = locals.l.get(0).shares;"), reject: true },
    // control: the type is renamed, no collision at all.
    { name: "renamed-no-collision", source: contract("LockEntry l;", "locals.l = state.get().last; output.shares = locals.l.shares;", "LockEntry", "LockEntry"), reject: false },
];

async function tsRejects(source: string): Promise<{ rejected: boolean; hidden: boolean }> {
    const result = await compileContractWithTypeScript({ source, contractName: "S", slot: 27, arenaSizeBytes: 1 << 20 });
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
    return { rejected: errors.length > 0, hidden: errors.some((error) => /hidden by a procedure or function/.test(error.message)) };
}

async function clangRejects(name: string, source: string): Promise<boolean> {
    const directory = mkdtempSync(join(tmpdir(), `f67-${name}-`));
    try {
        const contractPath = join(directory, "S.h");
        writeFileSync(contractPath, source);
        const built = await buildContractWithClang({
            contractPath,
            contractName: "S",
            slot: 27,
            corePath: CORE_PATH,
            outDir: directory,
            arenaSizeBytes: 1 << 20,
            skipVerify: true,
        });
        return !built.ok;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe.skipIf(!HAS_CORE)("F67 — struct hidden by a procedure of the same name", () => {
    const clang = wasiToolchain();

    for (const probe of PROBES) {
        test(`TypeScript ${probe.reject ? "rejects" : "accepts"}: ${probe.name}`, async () => {
            const { rejected, hidden } = await tsRejects(probe.source);
            expect(rejected).toBe(probe.reject);
            if (probe.reject) expect(hidden).toBe(true);
        });

        test.skipIf(!clang.available)(`clang parity: ${probe.name}`, async () => {
            const [ts, clangRejected] = await Promise.all([tsRejects(probe.source), clangRejects(probe.name, probe.source)]);
            expect(ts.rejected).toBe(clangRejected);
            expect(clangRejected).toBe(probe.reject);
        });
    }
});
