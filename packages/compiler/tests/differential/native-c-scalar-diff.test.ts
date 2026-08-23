import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { HEAVY_HOOK_TIMEOUT_MS } from "../support/fixture-shapes";
import { wasiToolchain } from "../support/container-toolchains";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const SLOT = 27;
// Mixed native C widths in state: if short/int/long are sized wrongly, every later field shifts.
const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Mixed {
    short tag;
    short count;
    int amount;
    long total;
    unsigned long mask;
  };
  struct StateData {
    Mixed mixed;
    uint64 checksum;
    uint64 reversed[4];
  };
  struct Run_input { uint64 tag; uint64 count; uint64 amount; uint64 total; };
  struct Run_output {};

  PUBLIC_PROCEDURE(Run)
  {
    state.mut().mixed.tag = (short)input.tag;
    state.mut().mixed.count = (short)input.count;
    state.mut().mixed.amount = (int)input.amount;
    state.mut().mixed.total = (long)input.total;
    state.mut().mixed.mask = (unsigned long)(input.tag + input.count);
    // A signed countdown past zero, with the counter used as a subscript. If int narrows by masking
    // instead of sign-extending, y wraps to 4294967295 and the loop runs off the end of the array.
    uint64 src[4];
    src[0] = input.tag; src[1] = input.count; src[2] = input.amount; src[3] = input.total;
    for (int y = 3; y > -1; y--) {
      state.mut().reversed[3 - y] = src[y];
    }
    state.mut().checksum = state.get().mixed.tag
      + state.get().mixed.count
      + state.get().mixed.amount
      + state.get().mixed.total
      + state.get().mixed.mask;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`;

const NATIVE_AVAILABLE = existsSync(CORE_PATH) && wasiToolchain().available;
const nativeTest = NATIVE_AVAILABLE ? test : test.skip;
let oursWasm: Uint8Array = new Uint8Array();
let nativeWasm = new Uint8Array();
let nativeDir: string | undefined;

function encodeInput(values: readonly bigint[]): Uint8Array {
    const input = new Uint8Array(32);
    const view = new DataView(input.buffer);
    values.forEach((value, index) => view.setBigUint64(index * 8, value, true));
    return input;
}

function execute(wasm: Uint8Array, input: readonly bigint[]): Uint8Array {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(SLOT, wasm);
    sim.procedure(SLOT, 1, encodeInput(input), { invocator: user });
    return new Uint8Array(sim.contracts.get(SLOT)!.state());
}

beforeAll(async () => {
    if (!HAS_CORE) {
        return;
    }
    await initK12();
    const ours = await compileContractWithTypeScript({
        source: SOURCE,
        contractName: "NativeCScalar",
        slot: SLOT,
        qpiHeader: loadQpiHeader(CORE_PATH),
        arenaSizeBytes: 1 << 20,
    });
    const errors = ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
    if (errors.length > 0) {
        throw new Error(errors.map((diagnostic) => diagnostic.message).join(" | "));
    }
    oursWasm = ours.wasm;

    if (NATIVE_AVAILABLE) {
        nativeDir = mkdtempSync(join(tmpdir(), "qinit-native-c-scalar-"));
        const contractPath = join(nativeDir, "NativeCScalar.h");
        writeFileSync(contractPath, SOURCE);
        const built = await buildContractWithClang({
            contractPath,
            contractName: "NativeCScalar",
            slot: SLOT,
            corePath: CORE_PATH,
            outDir: nativeDir,
            skipVerify: true,
        });
        if (!built.ok || !built.wasmPath) {
            throw new Error(built.stderr ?? "native native-c-scalar build failed");
        }
        nativeWasm = new Uint8Array(readFileSync(built.wasmPath));
    }
}, HEAVY_HOOK_TIMEOUT_MS);

afterAll(() => {
    if (nativeDir) rmSync(nativeDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_CORE)("native C scalar widths and signedness match the wasm32 target", () => {
    const vectors = [
        [5n, 9n, 300n, 70000n],
        [0n, 0n, 0n, 0n],
        [127n, 32767n, 2147483647n, 2147483647n],
    ] as const;

    for (const input of vectors) {
        nativeTest(`matches native state bytes: ${input.join(",")}`, () => {
            expect(WebAssembly.validate(oursWasm)).toBe(true);
            expect(Array.from(execute(oursWasm, input))).toEqual(Array.from(execute(nativeWasm, input)));
        });
    }
});
