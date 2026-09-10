// Name and scope resolution, pinned against clang. Each row is a defect the differential corpus found
// where the backend compiled the contract and answered a different number than the chain runs.
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { wasiToolchain } from "../support/container-toolchains";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

const wrap = (preamble: string, members: string, body: string) => `using namespace QPI;
${preamble}
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${members}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// Every expectation is the value clang produces, so agreeing with the other backend is not enough.
const CASES: Record<string, { source: string; expect: bigint }> = {
    // A leading `::` reaches the file-scope declaration past the namespaced one. 50 > 7 but not > 100.
    "the global-scope qualifier reaches past a namespaced name of the same name": {
        source: wrap(
            `static constexpr uint64 threshold = 7;
namespace Port { static constexpr uint64 threshold = 100; }`,
            `struct StateData { uint64 a; };`,
            `state.mut().a = (50 > ::threshold ? 1 : 0) + (50 > Port::threshold ? 10 : 0);`,
        ),
        expect: 1n,
    },
    // The bare name belongs to the nearest declaration — the file constant, not the namespaced enum.
    "the nearest declaration owns the bare name, not the last one collected": {
        source: wrap(
            `static constexpr uint64 Threshold = 5;
namespace Port { enum Limits { Threshold = 55 }; }`,
            `struct StateData { uint64 a; };`,
            `state.mut().a = Threshold * 1000 + Port::Threshold;`,
        ),
        expect: 5055n,
    },
    // A base named through a chain of aliases still contributes its members.
    "a base reached through three aliases still contributes its members": {
        source: wrap(
            `struct AliasBaseRoot { uint64 v; };
namespace Port {
  using BaseA = AliasBaseRoot;
  using BaseB = BaseA;
  using BaseC = BaseB;
}
struct Derived : public Port::BaseC {};`,
            `struct StateData { uint64 a; Derived d; };`,
            `state.mut().d.v = 42; state.mut().a = state.get().d.v;`,
        ),
        expect: 42n,
    },
    // An alias whose name equals its target's name must not answer a qualified lookup with itself.
    "an alias named after its own target resolves without recurring": {
        source: wrap(
            `namespace Inner { struct Payload { uint64 a; }; }
namespace Middle { using Payload = Inner::Payload; }`,
            `struct StateData { uint64 a; Middle::Payload payload; };`,
            `state.mut().payload.a = 42; state.mut().a = state.get().payload.a;`,
        ),
        expect: 42n,
    },
    // A file-scope struct's fields name file-scope types, not the contract's same-named nested ones.
    // Carrying the nested bindings down made the two structs contain each other and never terminate.
    "a file-scope struct resolves its fields in its own scope": {
        source: wrap(
            `struct Inner { uint64 wide; uint8 narrow; };
struct Outer { Inner inner; uint64 after; uint8 last; };`,
            `struct StateData { struct Inner { uint64 writes; }; uint64 a; Inner mine; Outer outer; };`,
            `state.mut().a = sizeof(Inner) * 1000 + sizeof(Outer);`,
        ),
        expect: 16032n,
    },
};

const runState = (wasm: Uint8Array): bigint => {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, wasm);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset).getBigUint64(0, true);
};

const wasiOk = wasiToolchain().available;

describe.skipIf(!HAS_CORE)("differential — name and scope resolution parity", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, testCase] of Object.entries(CASES)) {
        test(
            name,
            async () => {
                const ours = await compileContractWithTypeScript({
                    source: testCase.source,
                    contractName: "ScopeProbe",
                    slot: 27,
                    qpiHeader: HEADERS(),
                    arenaSizeBytes: 1 << 20,
                });
                expect(ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
                expect(runState(ours.wasm)).toBe(testCase.expect);

                if (wasiOk) {
                    const directory = mkdtempSync(join(tmpdir(), "scope-probe-"));
                    writeFileSync(join(directory, "ScopeProbe.h"), testCase.source);
                    const built = await buildContractWithClang({
                        contractPath: join(directory, "ScopeProbe.h"),
                        contractName: "ScopeProbe",
                        slot: 27,
                        corePath: CORE,
                        outDir: directory,
                        skipVerify: true,
                    });
                    expect(built.ok).toBe(true);
                    expect(runState(new Uint8Array(readFileSync(built.wasmPath!)))).toBe(testCase.expect);
                }
            },
            180000,
        );
    }
});
