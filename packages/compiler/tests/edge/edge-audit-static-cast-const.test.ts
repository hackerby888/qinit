// `static_cast<T>(x)` has no lexer keyword and reaches the AST as a template call, so the folder must recognise that shape or reject a registration input type.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { edgeRunner } from "../support/edge-compile";

const HEADERS = () => loadQpiHeader(CORE_PATH);

const contract = (registration: string, declarations = "", body = "") => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${declarations}
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { ${registration} }
};`;

async function compile(registration: string, declarations = "", body = "") {
    return compileContractWithTypeScript({
        source: contract(registration, declarations, body),
        contractName: "StaticCastConstEdge",
        slot: 27,
        qpiHeader: HEADERS(),
        arenaSizeBytes: 1 << 20,
    });
}

const errorsOf = async (registration: string, declarations = "") =>
    (await compile(registration, declarations)).diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((d) => d.message);

// Runs the contract and reads back state.result, so the value is the emitter's, not the folder's.
const run = edgeRunner("StaticCastConstEdge");
const evaluate = (body: string, declarations = "") => run(contract("REGISTER_USER_PROCEDURE(Go, 1);", declarations, body));

const SCOPED_ENUM = "enum class EProcedureId : uint8 { Go = 1 };";

describe.skipIf(!HAS_CORE)("edge audit — static_cast in constant position", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("a registration input type may be a cast scoped-enum member", async () => {
        expect(await errorsOf("REGISTER_USER_PROCEDURE(Go, static_cast<uint16>(EProcedureId::Go));", SCOPED_ENUM)).toEqual([]);
    });

    test("the cast composes with nesting and arithmetic", async () => {
        expect(await errorsOf("REGISTER_USER_PROCEDURE(Go, static_cast<uint16>(static_cast<uint8>(EProcedureId::Go)));", SCOPED_ENUM)).toEqual([]);
        expect(await errorsOf("REGISTER_USER_PROCEDURE(Go, static_cast<uint16>(EProcedureId::Go) + 0);", SCOPED_ENUM)).toEqual([]);
        expect(await errorsOf("REGISTER_USER_PROCEDURE(Go, static_cast<uint16>(1));")).toEqual([]);
    });

    test("an out-of-range cast constant is still range-checked, not waved through", async () => {
        const errors = await errorsOf("REGISTER_USER_PROCEDURE(Go, static_cast<uint16>(0));");
        expect(errors.join(" ")).toContain("must be in the range");
    });

    // If the folder narrowed differently from the emitter, these two numbers would disagree.
    test("a folded static_cast matches the value the emitter produces", async () => {
        expect(await evaluate("state.mut().result = (uint64)static_cast<uint8>(300);")).toBe(44n);
        expect(await evaluate("state.mut().result = (uint64)static_cast<uint16>(70000);")).toBe(4464n);
        expect(await evaluate("state.mut().result = (uint64)static_cast<uint64>(70000);")).toBe(70000n);
    });

    test("a cast that only changes the type keeps the value", async () => {
        expect(await evaluate("uint64 wide = 300; state.mut().result = (uint64)const_cast<uint64&>(wide);")).toBe(300n);
    });
});
