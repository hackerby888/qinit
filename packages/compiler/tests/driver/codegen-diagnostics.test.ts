// Backend failures used to surface at line 0, column 0; emitStatement tags them with the statement span, so an error points at the user's own line.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { describe, expect, test } from "bun:test";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src";

const HEADER = () => loadQpiHeader(CORE_PATH);

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
        qpiHeader: HEADER(),
        arenaSizeBytes: 1 << 20,
    });
    return result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
}

describe.skipIf(!HAS_CORE)("codegen diagnostics carry a source location", () => {
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

    test("an error with a source span reads as the mistake, without the stage name", async () => {
        const errors = await codegenErrors("    qpi.K12(7, 8);");

        expect(errors[0].message).not.toContain("Codegen failed");
    });

    test("an assignment to a missing member points at the target, spelled as written", async () => {
        const errors = await codegenErrors("    output.reslt = 1;");

        expect(errors.map((error) => error.message)).toEqual(["unsupported assignment target [output.reslt]"]);
        expect(errors[0].span.line).toBe(BODY_LINE);
        expect(errors[0].span.column).toBe(5);
    });

    test("a duplicate registration points at the second one", async () => {
        const result = await compileContractWithTypeScript({
            source: wrap("    output.result = 1;").replace("REGISTER_USER_FUNCTION(Run, 1); }", "REGISTER_USER_FUNCTION(Run, 1);\nREGISTER_USER_FUNCTION(Run, 1); }"),
            contractName: "Probe",
            slot: 27,
            qpiHeader: HEADER(),
            arenaSizeBytes: 1 << 20,
        });
        const duplicate = result.diagnostics.find((diagnostic) => diagnostic.message.includes("registered twice"));

        expect(duplicate?.span.line).toBe(BODY_LINE + 3);
    });

    test("the reported line tracks the statement, not the start of the function", async () => {
        const errors = await codegenErrors("    output.result = 1;\n    output.result = 2;\n    qpi.K12(7, 8);");

        expect(errors).toHaveLength(1);
        expect(errors[0].span.line).toBe(BODY_LINE + 2);
    });
});
