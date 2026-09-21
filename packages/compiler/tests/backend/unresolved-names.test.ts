// A name the compiler cannot resolve is a compile error, never a guessed size or a guessed constant.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { analyzeContract } from "../../src/analyzer";

const SLOT = 27;

const contract = (members: string, registrations = "") => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  ${members}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { ${registrations} }
};`;

// a procedure whose locals hold one member of `type`, which no entry signature and no state field mentions.
const withLocalOf = (type: string) =>
    contract(
        `struct Go_input {}; struct Go_output {}; struct Go_locals { ${type} held; uint64 after; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { locals.after = 1; state.mut().a = locals.after; }`,
        "REGISTER_USER_PROCEDURE(Go, 1);",
    );

type CompileOptions = Parameters<typeof compileContractWithTypeScript>[0];

async function compile(source: string, callee: Pick<CompileOptions, "callees" | "calleeSources"> = {}) {
    const result = await compileContractWithTypeScript({
        source,
        contractName: "T",
        slot: SLOT,
        qpiHeader: loadQpiHeader(CORE_PATH),
        arenaSizeBytes: 1 << 20,
        ...callee,
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

    test("a member of a type nobody declares is refused, not sized", async () => {
        const compiled = await compile(withLocalOf("Missing"));

        expect(compiled.wasm.length).toBe(0);
        expect(compiled.errors.join("\n")).toContain("unknown type 'Missing'");
    });

    test("a type owned by another contract needs that contract's source to build", async () => {
        const source = withLocalOf("Counter::Get_output");
        const counterSource = readFileSync(resolve("fixtures/Counter.h"), "utf8");
        const counter = await compileContractWithTypeScript({
            source: counterSource,
            contractName: "Counter",
            slot: SLOT - 1,
            qpiHeader: loadQpiHeader(CORE_PATH),
            arenaSizeBytes: 1 << 20,
        });

        const withoutCallee = await compile(source);
        expect(withoutCallee.wasm.length).toBe(0);
        expect(withoutCallee.errors.join("\n")).toContain("unknown type 'Counter::Get_output'");

        const withCallee = await compile(source, {
            callees: [counter.idl!],
            calleeSources: [{ name: "Counter", source: counterSource, slot: SLOT - 1 }],
        });
        expect(withCallee.errors).toEqual([]);
        expect(withCallee.wasm.length).toBeGreaterThan(0);
    });

    // the editor analyzes a file on its own, and core's contracts name callee types in exactly this way.
    test("the analyzer stays quiet about a callee type it was given no source for", () => {
        const analyzed = analyzeContract({ source: withLocalOf("Counter::Get_output"), qpiHeader: loadQpiHeader(CORE_PATH) });

        expect(analyzed.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);
        expect(analyzed.idl).toBeDefined();
    });

    test("a contract with no system procedure and no migration still compiles", async () => {
        const compiled = await compile(contract(""));
        expect(compiled.errors).toEqual([]);
        expect(compiled.wasm.length).toBeGreaterThan(0);
    });
});
