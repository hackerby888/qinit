import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Ensures each unsupported-feature tier fails, or survives, the strict gate as intended.
import { describe, expect, test } from "bun:test";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const HEADERS = () => loadQpiHeader(CORE_PATH);

// Native C spellings lower correctly at their wasm32 widths, so they must not fail a strict build.
const NATIVE_C_SRC = `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 x;
  };

  struct Probe_input {
    uint64 seed;
  };
  struct Probe_output {
    uint64 v;
  };
  PUBLIC_FUNCTION(Probe)
  {
    int counter = 3;
    char small = 5;
    long wide = 7;
    unsigned int positive = 11;
    output.v = counter + small + wide + positive + input.seed;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
  {
    REGISTER_USER_FUNCTION(Probe, 1);
  }
};
`;

describe.skipIf(!HAS_CORE)("native C scalar types are advisory, not fatal", () => {
    test("compiles under default strict and warns without erroring", async () => {
        const result = await compileContractWithTypeScript({
            source: NATIVE_C_SRC,
            contractName: "NativeCProbe",
            slot: 28,
            qpiHeader: HEADERS(),
        });

        const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
        const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.WARNING);

        expect(errors).toEqual([]);
        expect(result.wasm.length).toBeGreaterThan(0);
        expect(warnings.some((diagnostic) => /non-canonical native C type 'int'/.test(diagnostic.message))).toBe(true);
        expect(warnings.some((diagnostic) => /non-canonical native C type 'char'/.test(diagnostic.message))).toBe(true);
    });

    // The advisory is only correct if it rides a channel strict mode leaves alone, so pin the category.
    test("the advisory carries no category, which is what keeps strict from promoting it", async () => {
        const result = await compileContractWithTypeScript({
            source: NATIVE_C_SRC,
            contractName: "NativeCProbe",
            slot: 28,
            qpiHeader: HEADERS(),
        });

        const advisories = result.diagnostics.filter((diagnostic) => /non-canonical native C type/.test(diagnostic.message));

        expect(advisories.length).toBeGreaterThan(0);
        expect(advisories.every((diagnostic) => diagnostic.category === undefined)).toBe(true);
    });

    // A type used repeatedly should report once, not once per declaration.
    test("deduplicates per spelling and line", async () => {
        const result = await compileContractWithTypeScript({
            source: NATIVE_C_SRC,
            contractName: "NativeCProbe",
            slot: 28,
            qpiHeader: HEADERS(),
        });

        const messages = result.diagnostics.filter((d) => /non-canonical native C type/.test(d.message)).map((d) => `${d.message}@${d.span.line}`);

        expect(new Set(messages).size).toBe(messages.length);
    });
});
