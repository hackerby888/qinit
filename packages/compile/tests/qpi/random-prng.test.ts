import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, inspectWasmModule, loadQpiHeader } from "../../src";
import { readSourceTree } from "../support/source-tree";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);
const SLOT = 27;
const USER = new Uint8Array(32).fill(0x4d);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint16 r16;
    uint16 guard16;
    uint32 r32;
    uint32 guard32;
    uint64 r64;
    uint64 guard64;
    uint32 success16;
    uint32 success32;
    uint32 success64;
    uint64 seed;
    id first;
    id second;
    id third;
  };
  struct Generate_input { uint64 nonce; };
  struct Generate_output {};
  struct Seed_input { uint64 value; };
  struct Seed_output {};

  PUBLIC_PROCEDURE(Seed) { state.mut().seed = input.value; }
  PUBLIC_PROCEDURE(Generate) {
    state.mut().guard16 = 0xa55au;
    state.mut().guard32 = 0x5aa55aa5u;
    state.mut().guard64 = 0x0123456789abcdefull;
    state.mut().success16 = _rdrand16_step(reinterpret_cast<unsigned short*>(&state.mut().r16));
    state.mut().success32 = _rdrand32_step(reinterpret_cast<unsigned int*>(&state.mut().r32));
    state.mut().success64 = _rdrand64_step(reinterpret_cast<unsigned long long*>(&state.mut().r64));
    state.mut().first = id::randomValue();
    state.mut().second = m256i::randomValue();
    state.mut().third.setRandomValue();
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Seed, 1);
    REGISTER_USER_PROCEDURE(Generate, 2);
  }
};`;

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

async function compile(source = SOURCE) {
  const result = await compileContract({
    source,
    name: "RandomProbe",
    slot: SLOT,
    qpiHeader: HEADERS,
    arenaSz: 1 << 20,
  });
  expect(result.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR)).toEqual([]);
  expect(result.wasm.byteLength).toBeGreaterThan(0);
  return result;
}

function run(wasm: Uint8Array, tick: number, nonce: bigint, initialSeed?: bigint): Uint8Array {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  sim.tickN = tick;
  sim.deploy(SLOT, wasm);
  if (initialSeed !== undefined)
    sim.procedure(SLOT, 1, u64(initialSeed), { invocator: USER, originator: USER });
  sim.procedure(SLOT, 2, u64(nonce), { invocator: USER, originator: USER, reward: 17n });
  return sim.contracts.get(SLOT)!.state();
}

describe("chain-seeded source-compiled random values", () => {
  beforeAll(initK12);

  test("snapshot carries the authoritative random bodies", () => {
    expect(HEADERS).toContain("void setRandomValue()");
    expect(HEADERS).toContain("static m256i randomValue()");
    expect(HEADERS).toContain("_rdrand32_step");
    expect(HEADERS).toContain("_rdrand64_step");
  });

  test("all rdrand widths write through wasm32 pointers, return success, and advance", async () => {
    const { wasm, idl } = await compile();
    const state = run(wasm, 91, 7n);
    expect(state.byteLength).toBe(idl.stateSize);
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    expect(view.getUint16(2, true)).toBe(0xa55a);
    expect(view.getUint32(8, true)).toBe(0x5aa55aa5);
    expect(view.getBigUint64(24, true)).toBe(0x0123456789abcdefn);
    expect(view.getUint32(32, true)).toBe(1);
    expect(view.getUint32(36, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(1);
    expect(view.getUint16(0, true)).not.toBe(0);
    expect(view.getUint32(4, true)).not.toBe(0);
    expect(view.getBigUint64(16, true)).not.toBe(0n);
    expect(
      new Set([
        view.getUint16(0, true).toString(),
        view.getUint32(4, true).toString(),
        view.getBigUint64(16, true).toString(),
      ]).size,
    ).toBeGreaterThan(1);
  });

  test("authoritative static and instance methods fill distinct 256-bit values", async () => {
    const { wasm } = await compile();
    const state = run(wasm, 92, 8n);
    const first = state.slice(56, 88);
    const second = state.slice(88, 120);
    const third = state.slice(120, 152);
    for (const value of [first, second, third]) {
      expect(value.some((byte) => byte !== 0)).toBe(true);
      for (let limb = 0; limb < 4; limb++) {
        expect(
          new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(
            limb * 8,
            true,
          ),
        ).not.toBe(0n);
      }
    }
    expect(same(first, second)).toBe(false);
    expect(same(second, third)).toBe(false);
  });

  test("identical replay is byte-identical while tick, input, and resident state perturb the sequence", async () => {
    const { wasm } = await compile();
    const baseline = run(wasm, 100, 0x11n, 5n);
    expect(run(wasm, 100, 0x11n, 5n)).toEqual(baseline);
    expect(same(run(wasm, 101, 0x11n, 5n), baseline)).toBe(false);
    expect(same(run(wasm, 100, 0x12n, 5n), baseline)).toBe(false);
    expect(same(run(wasm, 100, 0x11n, 6n), baseline)).toBe(false);
  });

  test("nested dispatch restores the caller's random sequence", async () => {
    const source = (nested: boolean) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { id first; id second; };
  struct Run_input {}; struct Run_output {};
  POST_INCOMING_TRANSFER() { id nestedValue = id::randomValue(); }
  PUBLIC_PROCEDURE(Run) {
    state.mut().first = id::randomValue();
    ${nested ? "qpi.transfer(SELF, 1);" : ""}
    state.mut().second = id::randomValue();
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};`;
    const plain = await compileContract({
      source: source(false),
      name: "NestedRandom",
      slot: SLOT,
      qpiHeader: HEADERS,
      arenaSz: 1 << 20,
    });
    const reentrant = await compileContract({
      source: source(true),
      name: "NestedRandom",
      slot: SLOT,
      qpiHeader: HEADERS,
      arenaSz: 1 << 20,
    });
    expect(plain.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR)).toEqual([]);
    expect(reentrant.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR)).toEqual([]);
    expect(plain.wasm.byteLength, JSON.stringify(plain.diagnostics)).toBeGreaterThan(0);
    expect(reentrant.wasm.byteLength, JSON.stringify(reentrant.diagnostics)).toBeGreaterThan(0);
    const plainWasm = Uint8Array.from(plain.wasm);
    const reentrantWasm = Uint8Array.from(reentrant.wasm);
    const execute = (wasm: Uint8Array) => {
      const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
      sim.tickN = 123;
      sim.deploy(SLOT, wasm);
      sim.fund(sim.contractId(SLOT), 10n);
      sim.procedure(SLOT, 1, undefined, { invocator: USER, originator: USER });
      return sim.contracts.get(SLOT)!.state();
    };
    expect(execute(reentrantWasm)).toEqual(execute(plainWasm));
  });

  test("keeps the production import surface and has no random-method fallback", async () => {
    const { wasm } = await compile();
    const inspection = inspectWasmModule(wasm);
    expect(inspection.ok, inspection.diagnostics.map((item) => item.message).join("; ")).toBe(true);
    expect(inspection.imports.every((item) => item.module === "lhost")).toBe(true);
    expect(inspection.features).toEqual([]);

    // WAMR maps offset 0 to nullptr, so resident state must start above it.
    const module = await WebAssembly.compile(wasm);
    const lhost = Object.fromEntries(
      WebAssembly.Module.imports(module)
        .filter((item) => item.module === "lhost")
        .map((item) => [item.name, () => 0]),
    );
    const instance = await WebAssembly.instantiate(module, { lhost });
    expect((instance.exports.state_addr as CallableFunction)()).toBeGreaterThan(0);

    const framework = readSourceTree("../../src/backend/wasm/framework", import.meta.url);
    const memory = readSourceTree("../../src/backend/wasm/memory", import.meta.url);
    expect(framework).not.toContain('"qtest" "randomId"');
    expect(framework).not.toContain("$qt_random_id");
    expect(memory).not.toMatch(/calleeName\s*===\s*["'](?:QPI::)?id::randomValue["']/);
  });
});
