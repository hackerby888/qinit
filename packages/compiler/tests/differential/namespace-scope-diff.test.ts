// A name written unqualified inside a namespace means that namespace's declaration. Resolved from a flat bare
// name instead, the state lays out at a different size than clang gives it — and every internal path agrees on
// the wrong answer, so only the native build tells them apart.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { HEAVY_HOOK_TIMEOUT_MS } from "../support/fixture-shapes";
import { wasiToolchain } from "../support/container-toolchains";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const SLOT = 27;

// Each contract writes through the fields whose width is in question, so a wrong size shows up as differing
// bytes and not only as a differing state length.
const CONTRACTS = [
    {
        name: "ArrayBound",
        source: `using namespace QPI;
namespace Alpha { constexpr uint64 N = 2; struct R { uint64 v[N]; }; }
namespace Beta { constexpr uint64 N = 8; struct R { uint64 v[N]; }; }
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { Alpha::R a; Beta::R b; uint64 tail; };
  struct Run_input { uint64 x; };
  struct Run_output {};

  PUBLIC_PROCEDURE(Run)
  {
    state.mut().a.v[0] = input.x;
    state.mut().b.v[7] = input.x + 1;
    state.mut().tail = 171;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`,
    },
    {
        name: "TypedefShadow",
        source: `using namespace QPI;
typedef uint64 W;
namespace Alpha { typedef uint8 W; struct R { W v; uint8 z; }; }
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { Alpha::R a; uint64 tail; };
  struct Run_input { uint64 x; };
  struct Run_output {};

  PUBLIC_PROCEDURE(Run)
  {
    state.mut().a.v = (uint8)input.x;
    state.mut().a.z = 9;
    state.mut().tail = 171;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`,
    },
] as const;

const NATIVE_AVAILABLE = HAS_CORE && wasiToolchain().available;
const nativeTest = NATIVE_AVAILABLE ? test : test.skip;
const builds = new Map<string, { ours: Uint8Array; native: Uint8Array }>();
let nativeDir: string | undefined;

function encodeInput(value: bigint): Uint8Array {
    const input = new Uint8Array(32);
    new DataView(input.buffer).setBigUint64(0, value, true);
    return input;
}

function execute(wasm: Uint8Array, value: bigint): Uint8Array {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(SLOT, wasm);
    sim.procedure(SLOT, 1, encodeInput(value), { invocator: user });
    return new Uint8Array(sim.contracts.get(SLOT)!.state());
}

beforeAll(async () => {
    if (!NATIVE_AVAILABLE) {
        return;
    }

    await initK12();
    nativeDir = mkdtempSync(join(tmpdir(), "qinit-namespace-scope-"));

    for (const contract of CONTRACTS) {
        const ours = await compileContractWithTypeScript({
            source: contract.source,
            contractName: contract.name,
            slot: SLOT,
            qpiHeader: loadQpiHeader(CORE_PATH),
            arenaSizeBytes: 1 << 20,
        });
        const errors = ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
        if (errors.length > 0) {
            throw new Error(errors.map((diagnostic) => diagnostic.message).join(" | "));
        }

        const contractPath = join(nativeDir, `${contract.name}.h`);
        writeFileSync(contractPath, contract.source);
        const built = await buildContractWithClang({
            contractPath,
            contractName: contract.name,
            slot: SLOT,
            corePath: CORE_PATH,
            outDir: nativeDir,
            skipVerify: true,
        });
        if (!built.ok || !built.wasmPath) {
            throw new Error(built.stderr ?? `native ${contract.name} build failed`);
        }

        builds.set(contract.name, { ours: ours.wasm, native: new Uint8Array(readFileSync(built.wasmPath)) });
    }
}, HEAVY_HOOK_TIMEOUT_MS);

afterAll(() => {
    if (nativeDir) rmSync(nativeDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_CORE)("a namespace's own declarations size the state the way clang sizes it", () => {
    for (const contract of CONTRACTS) {
        nativeTest(`matches native state bytes: ${contract.name}`, () => {
            const built = builds.get(contract.name)!;
            expect(WebAssembly.validate(built.ours)).toBe(true);
            expect(Array.from(execute(built.ours, 5n))).toEqual(Array.from(execute(built.native, 5n)));
        });
    }
});
