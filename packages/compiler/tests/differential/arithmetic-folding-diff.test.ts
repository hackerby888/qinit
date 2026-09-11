// Constant-folded arithmetic whose C++ answer the backend used to reach a different way: an out-of-range shift count, and a signed 32-bit division that has to
// trap. Each row asserts the value clang produces, so agreeing with the other backend is not enough to pass.
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

const wrap = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 a; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

// A shift by a constant count outside [0, width) is undefined in C++ and clang's codegen answers 0 for every spelling. `<< -1` and `>> -3` are here because
// they land on 0 through wasm's six-bit masking as well, so a fold that never fires still passes them — they only mean something beside the rows above.
const VALUES: Record<string, { body: string; expect: bigint }> = {
    "a shift count above the operand width folds to zero": {
        body: `uint64 v = 10; state.mut().a = v << 254;`,
        expect: 0n,
    },
    "a right shift count above the operand width folds to zero": {
        body: `uint64 v = 10; state.mut().a = v >> 254;`,
        expect: 0n,
    },
    "a signed right shift count above the operand width folds to zero": {
        body: `sint64 v = -10; state.mut().a = (uint64)(v >> 254);`,
        expect: 0n,
    },
    "a negative literal shift count folds to zero": {
        body: `uint64 v = 10; state.mut().a = v << -3;`,
        expect: 0n,
    },
    "a negative computed shift count folds to zero": {
        body: `uint64 v = 10; state.mut().a = v << (0 - 3);`,
        expect: 0n,
    },
    "a count above a narrower operand's width folds to zero": {
        body: `uint32 n = 1u; state.mut().a = (uint64)(uint32)(n << 40);`,
        expect: 0n,
    },
    "an in-range shift count is untouched": {
        body: `uint64 v = 10; state.mut().a = v << 3;`,
        expect: 80n,
    },
    "signed 32-bit modulo by -1 is zero, not a trap": {
        body: `sint32 x = -2147483647 - 1; sint32 y = -1; state.mut().a = (uint64)(sint64)QPI::mod(x, y);`,
        expect: 0n,
    },
    "ordinary signed 32-bit division is unaffected": {
        body: `sint32 x = -6; sint32 y = 2; state.mut().a = (uint64)(sint64)QPI::div(x, y);`,
        expect: 18446744073709551613n,
    },
};

// The quotient of INT32_MIN / -1 is not representable, so wasm's i32.div_s traps. Widening to i64
// first made it a wrapped value instead, which is a wrong answer where the chain refuses to continue.
const TRAPS: Record<string, string> = {
    "signed 32-bit division overflow traps on both backends": `sint32 x = -2147483647 - 1; sint32 y = -1; state.mut().a = (uint64)(sint64)QPI::div(x, y);`,
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

const trapped = (wasm: Uint8Array): boolean => {
    try {
        runState(wasm);
        return false;
    } catch {
        return true;
    }
};

const compileOurs = async (source: string) => {
    const ours = await compileContractWithTypeScript({
        source,
        contractName: "ArithProbe",
        slot: 27,
        qpiHeader: HEADERS(),
        arenaSizeBytes: 1 << 20,
    });
    expect(ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    return ours.wasm;
};

const compileClang = async (source: string): Promise<Uint8Array> => {
    const directory = mkdtempSync(join(tmpdir(), "arith-probe-"));
    writeFileSync(join(directory, "ArithProbe.h"), source);
    const built = await buildContractWithClang({
        contractPath: join(directory, "ArithProbe.h"),
        contractName: "ArithProbe",
        slot: 27,
        corePath: CORE,
        outDir: directory,
        skipVerify: true,
    });
    expect(built.ok).toBe(true);
    return new Uint8Array(readFileSync(built.wasmPath!));
};

const wasiOk = wasiToolchain().available;

describe.skipIf(!HAS_CORE)("differential — constant folding and division parity", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, testCase] of Object.entries(VALUES)) {
        test(
            name,
            async () => {
                const source = wrap(testCase.body);
                expect(runState(await compileOurs(source))).toBe(testCase.expect);
                if (wasiOk) expect(runState(await compileClang(source))).toBe(testCase.expect);
            },
            180000,
        );
    }

    for (const [name, body] of Object.entries(TRAPS)) {
        test(
            name,
            async () => {
                const source = wrap(body);
                expect(trapped(await compileOurs(source))).toBe(true);
                if (wasiOk) expect(trapped(await compileClang(source))).toBe(true);
            },
            180000,
        );
    }
});
