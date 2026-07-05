// Fidelity probe for semantic edges where the i64 value model can drift from native C++: signed
// right-shift, raw / and % on unsigned operands, mixed-signedness comparisons, ternary laziness,
// prefix ++ on a uint128 lvalue (limb carry), uint128 shifts >= 128, and defined 32-bit unsigned
// wrap-around. Native clang is the judge: the gtest asserts the C++-semantics values and runs
// against the compiled contract.
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { runTestsAgainst, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Probe_input { sint64 sa; sint64 sb; uint64 ua; uint64 ub; };
  struct Probe_output {
    sint64 shrNeg; uint64 rawDivU; uint64 rawModU;
    uint64 cmpMix32; uint64 cmpMix64;
    sint64 lazyTern; uint64 wrap32;
    uint64 incLo; uint64 incHi;
    uint64 shlBigLo; uint64 shlBigHi; uint64 shrBigLo; uint64 shrBigHi;
  };
  struct Probe_locals { uint128 z; uint128 w; uint32 u32; };
  PUBLIC_FUNCTION_WITH_LOCALS(Probe)
  {
    output.shrNeg = input.sa >> 2;
    output.rawDivU = input.ua / input.ub;
    output.rawModU = input.ua % input.ub;

    locals.u32 = 5;
    output.cmpMix32 = (input.sa < locals.u32) ? 1 : 0;
    output.cmpMix64 = (input.sa < input.ua) ? 1 : 0;

    output.lazyTern = (input.sb != 0) ? (input.sa / input.sb) : -7;

    locals.u32 = 4294967295u;
    output.wrap32 = ((locals.u32 + 1) == 0) ? 1 : 0;

    locals.z = uint128(0, 0xFFFFFFFFFFFFFFFFull);
    ++locals.z;
    output.incLo = locals.z.low; output.incHi = locals.z.high;

    locals.z = uint128(3, 7);
    locals.w = locals.z << uint128(0, 130);
    output.shlBigLo = locals.w.low; output.shlBigHi = locals.w.high;
    locals.w = locals.z >> uint128(0, 129);
    output.shrBigLo = locals.w.low; output.shrBigHi = locals.w.high;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Probe, 1); }
};`;

const GTEST = `TEST(Fidelity, SemanticEdges) {
  ContractTest t;
  CONTRACT_STATE_TYPE::Probe_input in{};
  in.sa = -8ll; in.sb = 2ll; in.ua = 9223372036854775818ull; in.ub = 3ull;
  auto r = t.call<CONTRACT_STATE_TYPE::Probe_output>(1, in);
  EXPECT_EQ(r.shrNeg, -2ll);                        // arithmetic shift on signed
  EXPECT_EQ(r.rawDivU, 3074457345618258606ull);     // unsigned /
  EXPECT_EQ(r.rawModU, 0ull);
  EXPECT_EQ(r.cmpMix32, 1ull);                      // -8 < (uint32)5 — u32 promotes to sint64, SIGNED
  EXPECT_EQ(r.cmpMix64, 0ull);                      // -8 < (uint64) — unsigned compare
  EXPECT_EQ(r.lazyTern, -4ll);
  EXPECT_EQ(r.wrap32, 1ull);                        // 0xFFFFFFFF + 1 wraps to 0 in unsigned int
  EXPECT_EQ(r.incLo, 0ull);                         // ++uint128 carries into the high limb
  EXPECT_EQ(r.incHi, 1ull);
  EXPECT_EQ(r.shlBigLo, 0ull);                      // shift >= 128 is defined zero (uint128.h)
  EXPECT_EQ(r.shlBigHi, 0ull);
  EXPECT_EQ(r.shrBigLo, 0ull);
  EXPECT_EQ(r.shrBigHi, 0ull);
}

TEST(Fidelity, TernaryIsLazy) {
  ContractTest t;
  CONTRACT_STATE_TYPE::Probe_input in{};
  in.sa = 5ll; in.sb = 0ll; in.ua = 7ull; in.ub = 1ull;
  auto r = t.call<CONTRACT_STATE_TYPE::Probe_output>(1, in);
  EXPECT_EQ(r.lazyTern, -7ll);   // untaken arm divides by zero — must never evaluate
  EXPECT_EQ(r.rawDivU, 7ull);
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

describe("differential gtest — semantic fidelity edges", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my contract matches native C++ semantics on the edge vectors", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fidelity-edges-"));
    const contractPath = join(dir, "Edge.h");
    writeFileSync(contractPath, SRC);

    const built = await buildContract({
      contractPath, name: "Edge", slot: 28, corePath: CORE, outDir: dir,
      skipVerify: true, testSource: GTEST, testPath: "Edge.test.cpp",
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: SRC, name: "Edge", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runTestsAgainst(runnerWasm, mine.wasm);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message.split("\\n")[0]}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
