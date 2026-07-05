// Regression for two silent-divergence fixes:
//  (1) uint128 bitwise & | ^ — must operate on both limbs (was truncating to the low 64 bits).
//  (2) narrowing scalar casts (uint8/16/32, sint8/16, functional and static_cast) — the narrowed value must
//      be observable in-register (a compare/arith on the cast result before any store), not just on store.
// The expected values are computed by a BigInt reference implementing the C++ conversion semantics, so this
// runs without a native toolchain.
import { describe, test, expect, beforeAll } from "bun:test";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct F_input { sint64 x; sint64 k; sint64 ahi; sint64 alo; sint64 bhi; sint64 blo; };
  struct F_output {
    uint64 m8; uint64 m16; uint64 m32; uint64 s8; uint64 s16; uint64 cmp;
    uint64 andlo; uint64 andhi; uint64 orlo; uint64 orhi; uint64 xorlo; uint64 xorhi;
  };
  struct F_locals { uint128 a; uint128 b; uint128 r; };
  PUBLIC_FUNCTION_WITH_LOCALS(F)
  {
    output.m8  = uint64(uint8(input.x));
    output.m16 = uint64(uint16(input.x));
    output.m32 = uint64(uint32(input.x));
    output.s8  = uint64(sint8(input.x));
    output.s16 = uint64(sint16(input.x));
    output.cmp = (uint8(input.x) == input.k) ? 1 : 0;

    locals.a = uint128(input.ahi, input.alo);
    locals.b = uint128(input.bhi, input.blo);

    locals.r = locals.a & locals.b;
    output.andlo = locals.r.low; output.andhi = locals.r.high;
    locals.r = locals.a | locals.b;
    output.orlo = locals.r.low; output.orhi = locals.r.high;
    locals.r = locals.a ^ locals.b;
    output.xorlo = locals.r.low; output.xorhi = locals.r.high;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(F, 1); }
};`;

const U64 = (v: bigint): bigint => BigInt.asUintN(64, v);
const M64 = 0xffffffffffffffffn;

function reference(x: bigint, k: bigint, ahi: bigint, alo: bigint, bhi: bigint, blo: bigint) {
  const a = (U64(ahi) << 64n) | U64(alo);
  const b = (U64(bhi) << 64n) | U64(blo);
  const lo = (v: bigint) => v & M64;
  const hi = (v: bigint) => (v >> 64n) & M64;
  return {
    m8: U64(x) & 0xffn,
    m16: U64(x) & 0xffffn,
    m32: U64(x) & 0xffffffffn,
    s8: U64(BigInt.asIntN(8, U64(x))),
    s16: U64(BigInt.asIntN(16, U64(x))),
    cmp: (U64(x) & 0xffn) === U64(k) ? 1n : 0n,
    andlo: lo(a & b), andhi: hi(a & b),
    orlo: lo(a | b), orhi: hi(a | b),
    xorlo: lo(a ^ b), xorhi: hi(a ^ b),
  };
}

const OUT_FIELDS = ["m8", "m16", "m32", "s8", "s16", "cmp", "andlo", "andhi", "orlo", "orhi", "xorlo", "xorhi"] as const;

describe("tier-1: uint128 bitwise & narrowing casts", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("compiles clean under the strict fidelity gate", async () => {
    const r = await compileContract({ source: SRC, name: "T1", slot: 6, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  test("engine output matches the C++-semantics reference", async () => {
    const mine = await compileContract({ source: SRC, name: "T1", slot: 6, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(6, mine.wasm);

    const run = (x: bigint, k: bigint, ahi: bigint, alo: bigint, bhi: bigint, blo: bigint) => {
      const inp = new Uint8Array(48);
      const dv = new DataView(inp.buffer);
      [x, k, ahi, alo, bhi, blo].forEach((v, i) => dv.setBigInt64(i * 8, BigInt.asIntN(64, v), true));
      const out = sim.query(6, 1, inp);
      const odv = new DataView(out.buffer, out.byteOffset, out.byteLength);
      const got: Record<string, bigint> = {};
      OUT_FIELDS.forEach((f, i) => (got[f] = odv.getBigUint64(i * 8, true)));
      return got;
    };

    const vectors: Array<[bigint, bigint, bigint, bigint, bigint, bigint]> = [
      // x picks a full 64-bit pattern; k = low byte of x so the in-register compare must narrow to match.
      [0x1234_5678_9abc_def0n, 0xf0n, 0xf0f0n, 0x00ff_00ffn, 0x0ff0n, 0xff00_ff00n],
      // high limbs differ in the top nibble → a truncate-to-low impl gets every *hi wrong.
      [0x0000_0000_0000_0100n, 0x00n, 0xdead_0000_0000_beefn, 0x1111_2222_3333_4444n, 0xf0f0_ffff_0000_0f0fn, 0xaaaa_5555_cccc_3333n],
      [0xffn, 0xffn, 0x0n, 0x0n, 0x0n, 0x0n],
      [0x0n, 0x1n, 0x8000_0000_0000_0000n, 0x1n, 0x8000_0000_0000_0001n, 0x2n],
    ];

    for (const v of vectors) {
      const got = run(...v);
      const exp = reference(...v);
      for (const f of OUT_FIELDS) {
        expect(`${f}=${got[f]}`).toBe(`${f}=${exp[f]}`);
      }
    }
  });
});
