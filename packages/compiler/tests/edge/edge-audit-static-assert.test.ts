import { DiagnosticSeverity } from "../../src/shared/enums";
import { HAS_CORE } from "../../../../test-utils/paths";
// Checks static_assert evaluation as a compile-time safety boundary.
import { describe, expect, test } from "bun:test";
import { edgeCompiler } from "../support/edge-compile";

const compile = edgeCompiler("StaticAssertEdge");

const wrap = (classMember: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  ${classMember}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function expectFalseAssertionRejected(source: string) {
    const result = await compile(source);
    const errors = result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
    expect(errors.some((d) => /static.?assert|static assertion|edge assertion failed/i.test(d.message))).toBe(true);
    expect(result.wasm).toHaveLength(0);
}

describe.skipIf(!HAS_CORE)("edge audit — static_assert", () => {
    test("a false class-scope static_assert rejects the contract", async () => {
        await expectFalseAssertionRejected(wrap(`static_assert(1 == 2, "edge assertion failed");`, ""));
    });

    test("a false function-scope static_assert rejects the contract", async () => {
        await expectFalseAssertionRejected(wrap("", `static_assert(false, "edge assertion failed");`));
    });

    test("a true static_assert remains accepted", async () => {
        const result = await compile(wrap(`static_assert(sizeof(uint64) == 8, "uint64 layout");`, ""));
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        expect(WebAssembly.validate(result.wasm)).toBe(true);
    });
});
