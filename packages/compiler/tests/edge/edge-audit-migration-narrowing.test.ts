// A migration that narrows a persisted scalar is a note, on the build path too: the strict warning channel
// would be promoted to an error by the driver and leave the contract without wasm.
import { describe, expect, test } from "bun:test";
import { HAS_CORE } from "../../../../test-utils/paths";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { edgeCompiler } from "../support/edge-compile";

const compile = edgeCompiler("MigrateProbe");

const contract = (oldFields: string, newFields: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct OldStateData { ${oldFields} };
  struct StateData { ${newFields} };
  struct Go_input {}; struct Go_output {};
  MIGRATE() { state.mut().epoch = oldState.epoch; }
  PUBLIC_PROCEDURE(Go) { state.mut().epoch = 1; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const NARROWS = /^migration narrows persisted field 'balance'/;

describe.skipIf(!HAS_CORE)("migration narrowing on the build path", () => {
    test("a narrowing migration builds with one warning", async () => {
        const result = await compile(contract("uint64 balance; uint32 epoch;", "uint32 balance; uint32 epoch;"));
        const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
        const notes = result.diagnostics.filter((diagnostic) => NARROWS.test(diagnostic.message));

        expect(errors).toEqual([]);
        expect(notes.map((diagnostic) => diagnostic.severity)).toEqual([DiagnosticSeverity.WARNING]);
        expect(WebAssembly.validate(result.wasm)).toBe(true);
    }, 120000);

    test("a migration that keeps every value is silent", async () => {
        const result = await compile(contract("uint64 balance; uint32 epoch;", "uint64 balance; uint32 epoch;"));

        expect(result.diagnostics.filter((diagnostic) => NARROWS.test(diagnostic.message))).toEqual([]);
        expect(WebAssembly.validate(result.wasm)).toBe(true);
    }, 120000);
});
