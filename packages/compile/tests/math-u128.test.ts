// u128/safe-math semantics lock-down for divergence-sensitive cases.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { Sim, runTestsAgainst, type TestResult } from "@qinit/engine";
import { buildContract } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
namespace ML {
  template<typename T> static constexpr T min(const T& a, const T& b) { return (a < b) ? a : b; }
  template<typename T> static constexpr T max(const T& a, const T& b) { return (a > b) ? a : b; }
  template<typename T> static constexpr T abs(const T& a) { return (a < 0) ? -a : a; }
}
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct MathOp_input { sint64 sa; sint64 sb; uint64 ua; uint64 ub; };
  struct MathOp_output {
    sint64 divS; sint64 modS; uint64 divU; uint64 modU;
    sint64 minS; sint64 maxS; uint64 minU; uint64 maxU;
    sint64 absS; sint64 saddS; uint64 saddU; sint64 smulS; uint64 smulU;
  };
  struct U128Op_input { uint64 ahi; uint64 alo; uint64 bhi; uint64 blo; uint64 sh; };
  struct U128Op_output {
    uint64 addLo; uint64 addHi; uint64 subLo; uint64 subHi;
    uint64 mulLo; uint64 mulHi; uint64 divLo; uint64 divHi;
    uint64 shlLo; uint64 shlHi; uint64 shrLo; uint64 shrHi;
    uint64 lt; uint64 eq; uint64 le; uint64 gt;
  };
  struct U128Op_locals { uint128 a; uint128 b; uint128 r; };
  PUBLIC_FUNCTION(MathOp)
  {
    output.divS = QPI::div(input.sa, input.sb);
    output.modS = QPI::mod(input.sa, input.sb);
    output.divU = QPI::div(input.ua, input.ub);
    output.modU = QPI::mod(input.ua, input.ub);
    output.minS = ML::min(input.sa, input.sb);
    output.maxS = ML::max(input.sa, input.sb);
    output.minU = ML::min(input.ua, input.ub);
    output.maxU = ML::max(input.ua, input.ub);
    output.absS = ML::abs(input.sa);
    output.saddS = QPI::sadd(input.sa, input.sb);
    output.saddU = QPI::sadd(input.ua, input.ub);
    output.smulS = QPI::smul(input.sa, input.sb);
    output.smulU = QPI::smul(input.ua, input.ub);
  }
  PUBLIC_FUNCTION_WITH_LOCALS(U128Op)
  {
    locals.a = uint128(input.ahi, input.alo);
    locals.b = uint128(input.bhi, input.blo);

    locals.r = locals.a + locals.b; output.addLo = locals.r.low; output.addHi = locals.r.high;
    locals.r = locals.a - locals.b; output.subLo = locals.r.low; output.subHi = locals.r.high;
    locals.r = locals.a * locals.b; output.mulLo = locals.r.low; output.mulHi = locals.r.high;
    locals.r = QPI::div(locals.a, locals.b); output.divLo = locals.r.low; output.divHi = locals.r.high;
    locals.r = locals.a << uint128(0, input.sh); output.shlLo = locals.r.low; output.shlHi = locals.r.high;
    locals.r = locals.a >> uint128(0, input.sh); output.shrLo = locals.r.low; output.shrHi = locals.r.high;

    output.lt = (locals.a < locals.b) ? 1 : 0;
    output.eq = (locals.a == locals.b) ? 1 : 0;
    output.le = (locals.a <= locals.b) ? 1 : 0;
    output.gt = (locals.a > locals.b) ? 1 : 0;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(MathOp, 1);
    REGISTER_USER_FUNCTION(U128Op, 2);
  }
};`;

// ---- BigInt reference (math_lib.h / qpi.h semantics) ----

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const U128_MASK = 2n ** 128n - 1n;
const S = (v: bigint) => BigInt.asIntN(64, v);
const U = (v: bigint) => BigInt.asUintN(64, v);

function refMath(sa: bigint, sb: bigint, ua: bigint, ub: bigint) {
  return {
    divS: sb === 0n ? 0n : sa / sb,
    modS: sb === 0n ? 0n : sa % sb,
    divU: ub === 0n ? 0n : ua / ub,
    modU: ub === 0n ? 0n : ua % ub,
    minS: sa < sb ? sa : sb,
    maxS: sa > sb ? sa : sb,
    minU: ua < ub ? ua : ub,
    maxU: ua > ub ? ua : ub,
    absS: sa === I64_MIN ? I64_MIN : (sa < 0n ? -sa : sa),
    saddS: sa + sb > I64_MAX ? I64_MAX : sa + sb < I64_MIN ? I64_MIN : sa + sb,
    saddU: ua + ub > U64_MAX ? U64_MAX : ua + ub,
    smulS: sa * sb > I64_MAX ? I64_MAX : sa * sb < I64_MIN ? I64_MIN : sa * sb,
    smulU: ua * ub > U64_MAX ? U64_MAX : ua * ub,
  };
}

function refU128(a: bigint, b: bigint, sh: bigint) {
  const lo = (v: bigint) => v & U64_MAX;
  const hi = (v: bigint) => (v >> 64n) & U64_MAX;
  const add = (a + b) & U128_MASK;
  const sub = (a - b) & U128_MASK;
  const mul = (a * b) & U128_MASK;
  const div = b === 0n ? 0n : a / b;
  const shl = (a << sh) & U128_MASK;
  const shr = a >> sh;
  return {
    addLo: lo(add), addHi: hi(add), subLo: lo(sub), subHi: hi(sub),
    mulLo: lo(mul), mulHi: hi(mul), divLo: lo(div), divHi: hi(div),
    shlLo: lo(shl), shlHi: hi(shl), shrLo: lo(shr), shrHi: hi(shr),
    lt: a < b ? 1n : 0n, eq: a === b ? 1n : 0n, le: a <= b ? 1n : 0n, gt: a > b ? 1n : 0n,
  };
}

// ---- vectors ----

const S_EDGES = [0n, 1n, -1n, 2n, -2n, I64_MAX, I64_MIN, I64_MAX - 1n, I64_MIN + 1n,
  2n ** 32n, -(2n ** 32n), 2n ** 31n - 1n, 3037000499n, 3037000500n, -3037000500n];
const U_EDGES = [0n, 1n, 2n, U64_MAX, U64_MAX - 1n, 2n ** 63n, 2n ** 63n - 1n, 2n ** 32n, 2n ** 32n - 1n, 4294967296n * 4294967296n - 1n];
const U128_EDGES = [0n, 1n, U64_MAX, 2n ** 64n, 2n ** 64n + 1n, 2n ** 127n, U128_MASK, U128_MASK - 1n,
  0xdead0000_0000beefn << 64n | 0x11112222_33334444n];
const SHIFTS = [0n, 1n, 31n, 63n, 64n, 65n, 100n, 127n];

// Deterministic xorshift so failures reproduce.
function* rng(seed: bigint): Generator<bigint> {
  let x = seed;
  while (true) {
    x ^= (x << 13n) & U64_MAX;
    x ^= x >> 7n;
    x ^= (x << 17n) & U64_MAX;
    yield x & U64_MAX;
  }
}

const MATH_FIELDS = ["divS", "modS", "divU", "modU", "minS", "maxS", "minU", "maxU", "absS", "saddS", "saddU", "smulS", "smulU"] as const;
const SIGNED_FIELDS = new Set(["divS", "modS", "minS", "maxS", "absS", "saddS", "smulS"]);
const U128_FIELDS = ["addLo", "addHi", "subLo", "subHi", "mulLo", "mulHi", "divLo", "divHi", "shlLo", "shlHi", "shrLo", "shrHi", "lt", "eq", "le", "gt"] as const;

describe("safe-math + uint128 semantics vs BigInt reference", () => {
  let sim: Sim;

  beforeAll(async () => {
    await initK12();
    const mine = await compileContract({ source: SRC, name: "M128", slot: 6, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.deploy(6, mine.wasm);
  });

  const runMath = (sa: bigint, sb: bigint, ua: bigint, ub: bigint) => {
    const inp = new Uint8Array(32);
    const dv = new DataView(inp.buffer);
    dv.setBigInt64(0, sa, true);
    dv.setBigInt64(8, sb, true);
    dv.setBigUint64(16, ua, true);
    dv.setBigUint64(24, ub, true);
    const out = sim.query(6, 1, inp);
    const odv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const got: Record<string, bigint> = {};
    MATH_FIELDS.forEach((f, i) => (got[f] = SIGNED_FIELDS.has(f) ? odv.getBigInt64(i * 8, true) : odv.getBigUint64(i * 8, true)));
    return got;
  };

  const runU128 = (a: bigint, b: bigint, sh: bigint) => {
    const inp = new Uint8Array(40);
    const dv = new DataView(inp.buffer);
    dv.setBigUint64(0, (a >> 64n) & U64_MAX, true);
    dv.setBigUint64(8, a & U64_MAX, true);
    dv.setBigUint64(16, (b >> 64n) & U64_MAX, true);
    dv.setBigUint64(24, b & U64_MAX, true);
    dv.setBigUint64(32, sh, true);
    const out = sim.query(6, 2, inp);
    const odv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const got: Record<string, bigint> = {};
    U128_FIELDS.forEach((f, i) => (got[f] = odv.getBigUint64(i * 8, true)));
    return got;
  };

  test("scalar safe-math: edge grid + 150 random vectors", () => {
    const vectors: Array<[bigint, bigint, bigint, bigint]> = [];
    for (const sa of S_EDGES) {
      for (const sb of S_EDGES) {
        if (sa === I64_MIN && sb === -1n) continue; // UB: traps natively and in wasm alike
        vectors.push([sa, sb, U(sa), U(sb)]);
      }
    }
    const r = rng(0x9e3779b97f4a7c15n);
    for (let i = 0; i < 150; i++) {
      const [w, x, y, z] = [r.next().value, r.next().value, r.next().value, r.next().value];
      if (S(w) === I64_MIN && S(x) === -1n) continue;
      vectors.push([S(w), S(x), y, z]);
    }

    let checked = 0;
    for (const [sa, sb, ua, ub] of vectors) {
      const got = runMath(sa, sb, ua, ub);
      const exp = refMath(sa, sb, ua, ub) as Record<string, bigint>;
      for (const f of MATH_FIELDS) {
        const want = SIGNED_FIELDS.has(f) ? S(exp[f]) : U(exp[f]);
        if (got[f] !== want) {
          expect(`${f}(sa=${sa} sb=${sb} ua=${ua} ub=${ub}) = ${got[f]}`).toBe(`${f}(...) = ${want}`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4000);
  });

  test("uint128: edge grid with all shift distances + 100 random vectors", () => {
    const vectors: Array<[bigint, bigint, bigint]> = [];
    for (const a of U128_EDGES) {
      for (const b of U128_EDGES) {
        vectors.push([a, b, SHIFTS[(vectors.length % SHIFTS.length)]]);
      }
    }
    for (const a of U128_EDGES) {
      for (const sh of SHIFTS) {
        vectors.push([a, a, sh]);
      }
    }
    const r = rng(0xc0ffee123456789n);
    for (let i = 0; i < 100; i++) {
      const a = (r.next().value << 64n) | r.next().value;
      const b = (r.next().value << 64n) | r.next().value;
      vectors.push([a, b, r.next().value % 128n]);
    }

    let checked = 0;
    for (const [a, b, sh] of vectors) {
      const got = runU128(a, b, sh);
      const exp = refU128(a, b, sh) as Record<string, bigint>;
      for (const f of U128_FIELDS) {
        if (got[f] !== exp[f]) {
          expect(`${f}(a=${a.toString(16)} b=${b.toString(16)} sh=${sh}) = ${got[f].toString(16)}`).toBe(`${f}(...) = ${exp[f].toString(16)}`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2500);
  });
});

// ---- native differential: pin the boundary semantics against clang-compiled qpi.h itself ----

const GTEST = `TEST(MathSat, SaturationAndDivGuards) {
  ContractTest t;
  CONTRACT_STATE_TYPE::MathOp_input in{};
  // positive add overflow saturates
  in.sa = 9223372036854775807ll; in.sb = 1ll; in.ua = 18446744073709551615ull; in.ub = 1ull;
  auto r = t.call<CONTRACT_STATE_TYPE::MathOp_output>(1, in);
  EXPECT_EQ(r.saddS, 9223372036854775807ll);
  EXPECT_EQ(r.saddU, 18446744073709551615ull);
  EXPECT_EQ(r.divS, 9223372036854775807ll);
  EXPECT_EQ(r.modS, 0ll);
  // negative add overflow saturates to MIN (sb stays clear of the MIN/-1 division trap)
  in.sa = -9223372036854775807ll - 1ll; in.sb = -5ll; in.ua = 5ull; in.ub = 0ull;
  r = t.call<CONTRACT_STATE_TYPE::MathOp_output>(1, in);
  EXPECT_EQ(r.saddS, -9223372036854775807ll - 1ll);
  EXPECT_EQ(r.divU, 0ull);      // div by zero guarded
  EXPECT_EQ(r.modU, 0ull);
  EXPECT_EQ(r.absS, -9223372036854775807ll - 1ll);  // abs(INT64_MIN) wraps to itself
  // mul overflow saturates by result sign
  in.sa = 4611686018427387904ll; in.sb = 4ll; in.ua = 4294967296ull; in.ub = 4294967296ull;
  r = t.call<CONTRACT_STATE_TYPE::MathOp_output>(1, in);
  EXPECT_EQ(r.smulS, 9223372036854775807ll);
  EXPECT_EQ(r.smulU, 18446744073709551615ull);
  in.sa = 4611686018427387904ll; in.sb = -4ll; in.ua = 3ull; in.ub = 7ull;
  r = t.call<CONTRACT_STATE_TYPE::MathOp_output>(1, in);
  EXPECT_EQ(r.smulS, -9223372036854775807ll - 1ll);
  EXPECT_EQ(r.smulU, 21ull);
  // in-range results untouched
  in.sa = -100ll; in.sb = 7ll; in.ua = 100ull; in.ub = 7ull;
  r = t.call<CONTRACT_STATE_TYPE::MathOp_output>(1, in);
  EXPECT_EQ(r.divS, -14ll);     // truncation toward zero
  EXPECT_EQ(r.modS, -2ll);      // remainder keeps dividend sign
  EXPECT_EQ(r.saddS, -93ll);
  EXPECT_EQ(r.smulS, -700ll);
  EXPECT_EQ(r.minS, -100ll);
  EXPECT_EQ(r.maxU, 100ull);
}

TEST(MathSat, U128Boundaries) {
  ContractTest t;
  CONTRACT_STATE_TYPE::U128Op_input in{};
  // add carry across the limb boundary; sub borrow back
  in.ahi = 0ull; in.alo = 18446744073709551615ull; in.bhi = 0ull; in.blo = 1ull; in.sh = 64ull;
  auto r = t.call<CONTRACT_STATE_TYPE::U128Op_output>(2, in);
  EXPECT_EQ(r.addLo, 0ull); EXPECT_EQ(r.addHi, 1ull);
  EXPECT_EQ(r.subLo, 18446744073709551614ull); EXPECT_EQ(r.subHi, 0ull);
  EXPECT_EQ(r.mulLo, 18446744073709551615ull); EXPECT_EQ(r.mulHi, 0ull);
  EXPECT_EQ(r.shlLo, 0ull); EXPECT_EQ(r.shlHi, 18446744073709551615ull);
  EXPECT_EQ(r.lt, 0ull); EXPECT_EQ(r.gt, 1ull);
  // mul crossing into the high limb; div with a high-limb divisor
  in.ahi = 1ull; in.alo = 2ull; in.bhi = 0ull; in.blo = 18446744073709551615ull; in.sh = 1ull;
  r = t.call<CONTRACT_STATE_TYPE::U128Op_output>(2, in);
  EXPECT_EQ(r.mulLo, 18446744073709551614ull);   // (2^64+2)(2^64-1) mod 2^128 = 2^64 - 2
  EXPECT_EQ(r.mulHi, 0ull);
  EXPECT_EQ(r.divLo, 1ull); EXPECT_EQ(r.divHi, 0ull);
  // 0/x, x/0, x/x
  in.ahi = 0ull; in.alo = 0ull; in.bhi = 5ull; in.blo = 5ull; in.sh = 127ull;
  r = t.call<CONTRACT_STATE_TYPE::U128Op_output>(2, in);
  EXPECT_EQ(r.divLo, 0ull); EXPECT_EQ(r.divHi, 0ull);
  EXPECT_EQ(r.lt, 1ull); EXPECT_EQ(r.le, 1ull); EXPECT_EQ(r.eq, 0ull);
  in.ahi = 7ull; in.alo = 9ull; in.bhi = 0ull; in.blo = 0ull; in.sh = 0ull;
  r = t.call<CONTRACT_STATE_TYPE::U128Op_output>(2, in);
  EXPECT_EQ(r.divLo, 0ull); EXPECT_EQ(r.divHi, 0ull);   // div by zero guarded
  EXPECT_EQ(r.shlLo, 9ull); EXPECT_EQ(r.shlHi, 7ull);   // shift 0 = identity
  in.ahi = 7ull; in.alo = 9ull; in.bhi = 7ull; in.blo = 9ull; in.sh = 65ull;
  r = t.call<CONTRACT_STATE_TYPE::U128Op_output>(2, in);
  EXPECT_EQ(r.divLo, 1ull); EXPECT_EQ(r.eq, 1ull); EXPECT_EQ(r.le, 1ull);
  EXPECT_EQ(r.shrLo, 3ull); EXPECT_EQ(r.shrHi, 0ull);   // (7*2^64+9) >> 65
  EXPECT_EQ(r.shlLo, 0ull); EXPECT_EQ(r.shlHi, 18ull);
}
`;

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — safe-math saturation + uint128 boundaries", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my contract matches native clang on the boundary vectors", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "math-u128-"));
    const contractPath = join(dir, "M128.h");
    writeFileSync(contractPath, SRC);

    const built = await buildContract({
      contractPath, name: "M128", slot: 28, corePath: CORE, outDir: dir,
      skipVerify: true, testSource: GTEST, testPath: "M128.test.cpp",
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: SRC, name: "M128", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runTestsAgainst(runnerWasm, mine.wasm);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
