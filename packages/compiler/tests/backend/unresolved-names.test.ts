// A name the compiler cannot resolve is a compile error, never a guessed size or a guessed constant.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const SLOT = 27;

const contract = (members: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  ${members}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {}
};`;

async function compile(source: string) {
    const result = await compileContractWithTypeScript({
        source,
        contractName: "T",
        slot: SLOT,
        qpiHeader: loadQpiHeader(CORE_PATH),
        arenaSizeBytes: 1 << 20,
    });

    return {
        wasm: result.wasm,
        errors: result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message),
    };
}

describe.skipIf(!HAS_CORE)("names the contract never declares", () => {
    beforeAll(async () => {
        await initK12();
    });

    // core's macro declares `typedef NoData INITIALIZE_locals`, so a clang build exports sizeof(NoData) here.
    test("a system procedure written without locals exports the size of NoData", async () => {
        const compiled = await compile(contract("INITIALIZE() { state.mut().a = 1; }"));
        expect(compiled.errors).toEqual([]);

        const deployed = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true }).deploy(SLOT, compiled.wasm);
        expect(deployed.ex.sysproc_locals_size(0)).toBe(1);
    });

    test("a system procedure with locals exports their size", async () => {
        const compiled = await compile(
            contract(
                "struct INITIALIZE_locals { uint64 first; uint64 second; };\n  INITIALIZE_WITH_LOCALS() { locals.first = 1; state.mut().a = locals.first; }",
            ),
        );
        expect(compiled.errors).toEqual([]);

        const deployed = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true }).deploy(SLOT, compiled.wasm);
        expect(deployed.ex.sysproc_locals_size(0)).toBe(16);
    });

    test("a contract with no system procedure and no migration still compiles", async () => {
        const compiled = await compile(contract(""));
        expect(compiled.errors).toEqual([]);
        expect(compiled.wasm.length).toBeGreaterThan(0);
    });
});
