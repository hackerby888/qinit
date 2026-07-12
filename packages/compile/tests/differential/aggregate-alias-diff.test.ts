import { CORE_PATH } from "../../../../test-utils/paths";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const SLOT = 27;
const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Pair { uint64 a; uint64 b; };
  struct StateData {
    Pair left;
    Pair right;
    uint64 values[4];
    uint64 checksum;
  };
  struct Run_input { uint64 a; uint64 b; uint64 delta; uint64 tail; };
  struct Run_output {};

  PUBLIC_PROCEDURE(Run)
  {
    Pair local = { input.a, input.b };
    local = local;
    state.mut().left = local;
    state.mut().right = state.get().left;
    state.mut().right.a += input.delta;

    uint32 i = 0;
    state.mut().values[i++] = state.get().right.a;
    state.mut().values[i++] = state.get().right.b;
    state.mut().values[i++] = state.get().left.a;
    state.mut().values[i++] = state.get().left.b;

    Pair partial = { input.tail };
    state.mut().left = partial;
    state.mut().checksum = state.get().values[0]
      + state.get().values[1]
      + state.get().values[2]
      + state.get().values[3]
      + i;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`;

const NATIVE_AVAILABLE = (() => {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project") as {
      wasiSdkPaths: () => { clang: string };
    };
    return existsSync(CORE) && existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
})();

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
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  sim.deploy(SLOT, wasm);
  sim.procedure(SLOT, 1, encodeInput(input), { invocator: user });
  return new Uint8Array(sim.contracts.get(SLOT)!.state());
}

function words(state: Uint8Array): bigint[] {
  expect(state.byteLength).toBeGreaterThanOrEqual(72);
  const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
  return Array.from({ length: 9 }, (_, index) => view.getBigUint64(index * 8, true));
}

beforeAll(async () => {
  await initK12();
  const ours = await compileContract({
    source: SOURCE,
    name: "AggregateAlias",
    slot: SLOT,
    qpiHeader: loadQpiHeader(CORE),
    arenaSz: 1 << 20,
  });
  const errors = ours.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((diagnostic) => diagnostic.message).join(" | "));
  }
  oursWasm = ours.wasm;

  if (NATIVE_AVAILABLE) {
    nativeDir = mkdtempSync(join(tmpdir(), "qinit-aggregate-alias-"));
    const contractPath = join(nativeDir, "AggregateAlias.h");
    writeFileSync(contractPath, SOURCE);
    const built = await buildContract({
      contractPath,
      name: "AggregateAlias",
      slot: SLOT,
      corePath: CORE,
      outDir: nativeDir,
      skipVerify: true,
    });
    if (!built.ok || !built.so) {
      throw new Error(built.stderr ?? "native aggregate-alias build failed");
    }
    nativeWasm = new Uint8Array(readFileSync(built.so));
  }
});

afterAll(() => {
  if (nativeDir) rmSync(nativeDir, { recursive: true, force: true });
});

describe("aggregate initialization and aliasing", () => {
  const vectors = [
    [5n, 9n, 3n, 11n],
    [0n, 0n, 0n, 0n],
    [0xffff_ffffn, 7n, 1n, 42n],
  ] as const;

  for (const input of vectors) {
    test(`self-copy, partial init, and side-effect index: ${input.join(",")}`, () => {
      expect(WebAssembly.validate(oursWasm)).toBe(true);
      const state = execute(oursWasm, input);
      const [a, b, delta, tail] = input;
      const rightA = BigInt.asUintN(64, a + delta);

      expect(words(state)).toEqual([
        tail,
        0n,
        rightA,
        b,
        rightA,
        b,
        a,
        b,
        BigInt.asUintN(64, rightA + b + a + b + 4n),
      ]);
    });

    nativeTest(`matches native state bytes: ${input.join(",")}`, () => {
      const oursState = execute(oursWasm, input);
      const nativeState = execute(nativeWasm, input);

      expect(Array.from(oursState)).toEqual(Array.from(nativeState));
    });
  }
});
