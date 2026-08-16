// Backend failures used to surface at line 0, column 0. emitStatement tags them with the statement span,
// so a codegen error now points at the offending line in the user's file rather than the qpi.h prelude.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
import { describe, expect, test } from "bun:test";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src";

const HEADER = loadQpiHeader(CORE_PATH);

// The body lands on line 8, which is what a reported span must point at.
const BODY_LINE = 8;
const wrap = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Run_input {};
  struct Run_output { id digest; sint64 result; };
  PUBLIC_FUNCTION(Run) {
${body}
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Run, 1); }
};`;

async function codegenErrors(body: string) {
    const result = await compileContractWithTypeScript({
        source: wrap(body),
        contractName: "Probe",
        slot: 27,
        qpiHeader: HEADER,
        arenaSizeBytes: 1 << 20,
    });
    return result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR && diagnostic.message.startsWith("Codegen failed"));
}

describe("codegen diagnostics carry a source location", () => {
    test("a bad QPI call reports the offending line", async () => {
        const errors = await codegenErrors("    qpi.K12(7, 8);");

        expect(errors).toHaveLength(1);
        expect(errors[0].span.line).toBe(BODY_LINE);
        expect(errors[0].span.column).toBeGreaterThan(0);
    });

    test("a missing primitive argument reports the offending line", async () => {
        const errors = await codegenErrors("    output.result = div(1);");

        expect(errors).toHaveLength(1);
        expect(errors[0].span.line).toBe(BODY_LINE);
    });

    test("the reported line tracks the statement, not the start of the function", async () => {
        const errors = await codegenErrors("    output.result = 1;\n    output.result = 2;\n    qpi.K12(7, 8);");

        expect(errors).toHaveLength(1);
        expect(errors[0].span.line).toBe(BODY_LINE + 2);
    });
});
