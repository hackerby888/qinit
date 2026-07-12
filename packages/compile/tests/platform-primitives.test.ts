import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import { compileContract, loadQpiHeader } from "../src";
import { PLATFORM_PRIMITIVES, platformPrimitive } from "../src/codegen/platform-primitives";

const CORE = process.env.QINIT_CORE ?? "/home/kali/Projects/core-lite";
const HEADER = loadQpiHeader(CORE);

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Run_input {};
  struct Run_output {
    m256i zero; m256i limbs; m256i bytes; m256i aliasCopy;
    uint64 zeroCheck; uint64 nonzeroCheck; uint64 equalCheck; uint64 leading; uint64 trailing;
    uint64 umulLow; uint64 umulHigh; sint64 smulLow; sint64 smulHigh;
  };
  PUBLIC_FUNCTION(Run) {
    output.zero = m256i::zero();
    m256i limbs(1, 2, 3, 4);
    m256i bytes(1, 2, 3, 4, 5);
    __m256i raw = _mm256_lddqu_si256(reinterpret_cast<const __m256i*>(&limbs));
    output.limbs = limbs;
    output.bytes = bytes;
    output.aliasCopy = m256i(raw);
    output.zeroCheck = isZero(output.zero);
    output.nonzeroCheck = isZero(output.limbs);
    output.equalCheck = limbs == m256i(1, 2, 3, 4);
    output.leading = __lzcnt64(0);
    output.trailing = _tzcnt64(16);
    uint64 unsignedHigh;
    output.umulLow = _umul128(0xffffffffffffffffull, 2, &unsignedHigh);
    output.umulHigh = unsignedHigh;
    sint64 signedHigh;
    output.smulLow = _mul128(-1, 2, &signedHigh);
    output.smulHigh = signedHigh;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Run, 1); }
};`;

describe("typed platform primitive registry", () => {
  beforeAll(initK12);

  test("aliases are unique and resolve to typed descriptors", () => {
    const spellings = PLATFORM_PRIMITIVES.flatMap((descriptor) => [descriptor.name, ...descriptor.aliases]);
    expect(new Set(spellings).size).toBe(spellings.length);
    expect(platformPrimitive("_mm256_lddqu_si256")?.kind).toBe("memory-load");
    expect(platformPrimitive("math_lib::__lzcnt64")?.wasmOp).toBe("i64.clz");
    expect(platformPrimitive("_rdrand64_step")?.capabilities).toEqual(["chain-prng"]);
  });

  test("zero, overloaded constructors, conversion helpers, and isZero compile from core source", async () => {
    const result = await compileContract({ source: SOURCE, name: "PlatformSource", slot: 27, qpiHeader: HEADER, arenaSz: 1 << 20 });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(27, result.wasm);
    const output = sim.query(27, 1);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    expect(output.slice(0, 32)).toEqual(new Uint8Array(32));
    expect([0, 1, 2, 3].map((lane) => view.getBigUint64(32 + lane * 8, true))).toEqual([1n, 2n, 3n, 4n]);
    expect([...output.slice(64, 69)]).toEqual([1, 2, 3, 4, 5]);
    expect([0, 1, 2, 3].map((lane) => view.getBigUint64(96 + lane * 8, true))).toEqual([1n, 2n, 3n, 4n]);
    expect(view.getBigUint64(128, true)).toBe(1n);
    expect(view.getBigUint64(136, true)).toBe(0n);
    expect(view.getBigUint64(144, true)).toBe(1n);
    expect(view.getBigUint64(152, true)).toBe(64n);
    expect(view.getBigUint64(160, true)).toBe(4n);
    expect(view.getBigUint64(168, true)).toBe(0xfffffffffffffffen);
    expect(view.getBigUint64(176, true)).toBe(1n);
    expect(view.getBigInt64(184, true)).toBe(-2n);
    expect(view.getBigInt64(192, true)).toBe(-1n);
  });

  test("migrated semantics appear only in the registry", () => {
    const addr = readFileSync(new URL("../src/codegen/addr.ts", import.meta.url), "utf8");
    const dispatch = readFileSync(new URL("../src/codegen/calls/dispatch.ts", import.meta.url), "utf8");
    expect(addr).not.toContain('expr.callee.name === "m256i::zero"');
    expect(addr).not.toContain('expr.callee.name === "_mm256_set_epi64x"');
    expect(dispatch).not.toMatch(/intrinsic === "_(?:tzcnt|lzcnt)/);
    expect(dispatch).not.toMatch(/\^_rdrand/);
  });
});
