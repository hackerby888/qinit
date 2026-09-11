// Reading a declaration correctly: which overload a call selects, and whether a sizeof operand is read
// as a type-id. Both answered differently from clang while still compiling and running.
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

// The shape qpi.h's DateAndTime::add has: a short overload beside a longer one whose trailing
// parameters carry defaults, so no candidate matches an under-supplied call on arity alone.
const wrap = (body: string) => `using namespace QPI;
struct Box { sint64 total; };
static void narrow(Box& b, sint64 a1, sint64 a2, sint64 a3) { b.total = 100 * a1 + 10 * a2 + a3; }
static void narrow(Box& b, sint64 a1, sint64 a2, sint64 a3, sint64 a4, sint64 a5, sint64 a6, sint64 a7 = 0, sint64 a8 = 0) {
  b.total = 100 * a1 + 10 * a2 + a3 + a4 + a5 + a6 + a7 + a8;
}
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {}; struct Go_locals { Box box; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const CASES: Record<string, { body: string; expect: bigint }> = {
    "a call matching the short overload on arity picks it": {
        body: `locals.box.total = 0; narrow(locals.box, 1, 2, 3); state.mut().a = (uint64)locals.box.total;`,
        expect: 123n,
    },
    // Under-supplied for the long overload but too long for the short one. Comparing arity for equality
    // made every candidate non-viable, and the loop then kept its seed — the first-declared overload.
    "a call that has to default two parameters still picks the long overload": {
        body: `locals.box.total = 0; narrow(locals.box, 1, 2, 3, 4, 5, 6); state.mut().a = (uint64)locals.box.total;`,
        expect: 138n,
    },
    // A multi-argument template as a sizeof operand: read as an expression it stops at the first comma.
    "sizeof reads a multi-argument template as a type-id": {
        body: `state.mut().a = sizeof(Array<uint64, 8>) * 1000 + sizeof(uint64);`,
        expect: 64008n,
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

describe.skipIf(!HAS_CORE)("differential — overload selection and sizeof operands", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, testCase] of Object.entries(CASES)) {
        test(
            name,
            async () => {
                const source = wrap(testCase.body);
                const ours = await compileContractWithTypeScript({
                    source,
                    contractName: "SelectProbe",
                    slot: 27,
                    qpiHeader: HEADERS(),
                    arenaSizeBytes: 1 << 20,
                });
                expect(ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
                expect(runState(ours.wasm)).toBe(testCase.expect);

                if (wasiOk) {
                    const directory = mkdtempSync(join(tmpdir(), "select-probe-"));
                    writeFileSync(join(directory, "SelectProbe.h"), source);
                    const built = await buildContractWithClang({
                        contractPath: join(directory, "SelectProbe.h"),
                        contractName: "SelectProbe",
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
