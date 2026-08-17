import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Mixed signed/unsigned conversions. width32-diff covers same-signedness width; nothing pinned the branch
// of usualConversion that picks div_s over div_u, where a mistake is a 2^64-scale answer with no diagnostic.
import { wasiToolchain } from "../support/container-toolchains";
import { describe, test, expect, beforeAll } from "bun:test";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

const wrap = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// Each expectation is the C++ result, so a signed/unsigned mix-up in either compiler shows up here.
const CASES: Record<string, { body: string; expect: bigint }> = {
    "sint64 divided by uint32 stays signed": {
        body: `sint64 x = -10; uint32 y = 3u; state.mut().a = (uint64)(x / y);`,
        expect: 18446744073709551613n,
    },
    "sint64 modulo uint32 stays signed": {
        body: `sint64 x = -7; uint32 y = 2u; state.mut().a = (uint64)(x % y);`,
        expect: 18446744073709551615n,
    },
    "sint32 compared with uint32 converts to unsigned": {
        body: `sint32 x = -1; uint32 y = 1u; state.mut().a = (x < y) ? 1 : 0;`,
        expect: 0n,
    },
    "sint64 compared with uint64 converts to unsigned": {
        body: `sint64 x = -1; uint64 y = 1; state.mut().a = (x < y) ? 1 : 0;`,
        expect: 0n,
    },
    "sint32 right shift is arithmetic": {
        body: `sint32 x = -8; state.mut().a = (uint64)(sint64)(x >> 1);`,
        expect: 18446744073709551612n,
    },
    "uint32 right shift is logical": {
        body: `uint32 x = 4294967295u; state.mut().a = x >> 1;`,
        expect: 2147483647n,
    },
    "uint8 operands promote to int before adding": {
        body: `uint8 x = 200; uint8 y = 100; state.mut().a = (uint64)(sint64)(x + y);`,
        expect: 300n,
    },
    "a sint32 to uint32 cast reinterprets the bits": {
        body: `sint32 x = -1; state.mut().a = (uint64)(uint32)x;`,
        expect: 4294967295n,
    },
    "uint32 times sint32 wraps unsigned": {
        body: `uint32 x = 1u; sint32 y = -1; state.mut().a = (uint64)(uint32)(x * y);`,
        expect: 4294967295n,
    },
    "sint32 division truncates toward zero": {
        body: `sint32 x = -5; state.mut().a = (uint64)(sint64)(x / 2);`,
        expect: 18446744073709551614n,
    },
};

const run = (wasm: Uint8Array): bigint => {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, wasm);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset).getBigUint64(0, true);
};

const wasiOk = wasiToolchain().available;

describe.skipIf(!HAS_CORE)("differential — mixed signed/unsigned state parity", () => {
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
                    contractName: "Signedness",
                    slot: 27,
                    qpiHeader: HEADERS(),
                    arenaSizeBytes: 1 << 20,
                });
                expect(ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
                expect(run(ours.wasm)).toBe(testCase.expect);

                if (wasiOk) {
                    const dir = mkdtempSync(join(tmpdir(), "signedness-"));
                    writeFileSync(join(dir, "Signedness.h"), source);
                    const built = await buildContractWithClang({
                        contractPath: join(dir, "Signedness.h"),
                        contractName: "Signedness",
                        slot: 27,
                        corePath: CORE,
                        outDir: dir,
                        skipVerify: true,
                    });
                    expect(built.ok).toBe(true);
                    expect(run(new Uint8Array(readFileSync(built.wasmPath!)))).toBe(testCase.expect);
                }
            },
            180000,
        );
    }
});
