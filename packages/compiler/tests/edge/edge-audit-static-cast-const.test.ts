// `static_cast<T>(x)` has no keyword in the lexer, so it reaches the AST as a template call on the name
// `static_cast`. The constant folder has to recognise that shape, or a registration input type written as
// `static_cast<uint16>(EProcedureId::X)` — the form the system contracts use — is rejected as non-constant.
// The parity rows are the point: a folded cast must equal what the emitter produces for the same cast.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

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
async function evaluate(body: string, declarations = ""): Promise<bigint> {
    const result = await compile("REGISTER_USER_PROCEDURE(Go, 1);", declarations, body);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, result.wasm!);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

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
