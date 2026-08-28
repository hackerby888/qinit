import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Differential gtest for the id/m256i limb views. A 256-bit id is addressable as 4x uint64, 8x uint32,
// 16x uint16 or 32x uint8, and ID_VIEWS (address-resolution.ts limbLayout) gives each limb its offset.
// Collapsing every one of those offsets to zero — so `.u64._1` reads the same bytes as `._0` — passed the
// entire suite: no fixture or unit test reads a limb past _0, and the system contracts that do are only
// ever checked for "does it build", which a wrong offset still does. Real contracts depend on it; QRaffle
// mixes all four u64 limbs of two digests into its RNG seed.
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, expect, beforeAll } from "bun:test";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

const LIMBS = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 unused; };

  struct U64_input { id who; }; struct U64_output { uint64 a; uint64 b; uint64 c; uint64 d; };
  PUBLIC_FUNCTION(U64) {
    output.a = input.who.u64._0; output.b = input.who.u64._1;
    output.c = input.who.u64._2; output.d = input.who.u64._3;
  }

  struct U32_input { id who; }; struct U32_output { uint64 lo; uint64 mid; uint64 hi; };
  PUBLIC_FUNCTION(U32) {
    output.lo = input.who.u32._1; output.mid = input.who.u32._4; output.hi = input.who.u32._7;
  }

  struct U8_input { id who; }; struct U8_output { uint64 first; uint64 mid; uint64 last; };
  PUBLIC_FUNCTION(U8) {
    output.first = input.who.u8._1; output.mid = input.who.u8._16; output.last = input.who.u8._31;
  }

  // Assigning a constructed m256i to a local goes through address-emitter, which is already covered.
  struct Mix_input { id x; id y; }; struct Mix_output { uint64 v; };
  struct Mix_locals { m256i seed; };
  PUBLIC_FUNCTION_WITH_LOCALS(Mix) {
    locals.seed = m256i(
      input.x.u64._0 ^ input.y.u64._0, input.x.u64._1 ^ input.y.u64._1,
      input.x.u64._2 ^ input.y.u64._2, input.x.u64._3 ^ input.y.u64._3);
    output.v = locals.seed.u64._0 + locals.seed.u64._1 * 3 + locals.seed.u64._2 * 5 + locals.seed.u64._3 * 7;
  }

  // A constructed m256i used inline rather than assigned. QRaffle builds its RNG seed this way,
  // qpi.K12(m256i(a, b, c, d)), so the shape is worth pinning even though it shares the resolver above.
  struct Temp_input { id x; }; struct Temp_output { uint64 same; uint64 swapped; };
  PUBLIC_FUNCTION(Temp) {
    // Rebuilt from x's own limbs, in order, the temporary must equal x.
    output.same = (m256i(input.x.u64._0, input.x.u64._1, input.x.u64._2, input.x.u64._3) == input.x) ? 1 : 0;
    // With two limbs swapped it must not. Collapse the lane offsets and both answers change.
    output.swapped = (m256i(input.x.u64._1, input.x.u64._0, input.x.u64._2, input.x.u64._3) == input.x) ? 1 : 0;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(U64, 1); REGISTER_USER_FUNCTION(U32, 2);
    REGISTER_USER_FUNCTION(U8, 3); REGISTER_USER_FUNCTION(Mix, 4);
    REGISTER_USER_FUNCTION(Temp, 5);
  }
};`;

const LIMBS_GTEST = coreGtest(
    "Limbs",
    `static id patterned() {
  id v;
  v.u64._0 = 0x0123456789abcdefULL; v.u64._1 = 0xfedcba9876543210ULL;
  v.u64._2 = 0x1111222233334444ULL; v.u64._3 = 0x5555666677778888ULL;
  return v;
}
static id other() {
  id v;
  v.u64._0 = 0x00000000000000ffULL; v.u64._1 = 0x000000000000ff00ULL;
  v.u64._2 = 0x0000000000ff0000ULL; v.u64._3 = 0x00000000ff000000ULL;
  return v;
}

TEST(Limbs, EveryU64LimbIsDistinct) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::U64_input in{}; in.who = patterned();
  auto r = t.call<CONTRACT_STATE_TYPE::U64_output>(1, in);
  EXPECT_EQ(r.a, patterned().u64._0);
  EXPECT_EQ(r.b, patterned().u64._1);
  EXPECT_EQ(r.c, patterned().u64._2);
  EXPECT_EQ(r.d, patterned().u64._3);
  // The point of the test: they must not all be the same limb.
  EXPECT_NE(r.a, r.b); EXPECT_NE(r.b, r.c); EXPECT_NE(r.c, r.d);
}

TEST(Limbs, NarrowerViewsIndexTheSameBytes) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::U32_input in{}; in.who = patterned();
  auto r = t.call<CONTRACT_STATE_TYPE::U32_output>(2, in);
  EXPECT_EQ(r.lo, (uint64)patterned().u32._1);
  EXPECT_EQ(r.mid, (uint64)patterned().u32._4);
  EXPECT_EQ(r.hi, (uint64)patterned().u32._7);

  CONTRACT_STATE_TYPE::U8_input in8{}; in8.who = patterned();
  auto r8 = t.call<CONTRACT_STATE_TYPE::U8_output>(3, in8);
  EXPECT_EQ(r8.first, (uint64)patterned().u8._1);
  EXPECT_EQ(r8.mid, (uint64)patterned().u8._16);
  EXPECT_EQ(r8.last, (uint64)patterned().u8._31);
}

TEST(Limbs, ConstructedTemporaryKeepsItsLanes) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::Temp_input in{}; in.x = patterned();
  auto r = t.call<CONTRACT_STATE_TYPE::Temp_output>(5, in);
  EXPECT_EQ(r.same, 1ull);
  EXPECT_EQ(r.swapped, 0ull);
}

TEST(Limbs, SeedMixUsesEveryLimb) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::Mix_input in{}; in.x = patterned(); in.y = other();
  auto r = t.call<CONTRACT_STATE_TYPE::Mix_output>(4, in);
  uint64 l0 = patterned().u64._0 ^ other().u64._0;
  uint64 l1 = patterned().u64._1 ^ other().u64._1;
  uint64 l2 = patterned().u64._2 ^ other().u64._2;
  uint64 l3 = patterned().u64._3 ^ other().u64._3;
  EXPECT_EQ(r.v, (uint64)(l0 + l1 * 3 + l2 * 5 + l3 * 7));
}
`,
);

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("differential gtest — id/m256i limb views", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "every limb of an id reads its own bytes",
        wasi,
        async () => {
            const runnerWasm = await buildDifferentialRunner({
                corePath: CORE,
                source: LIMBS,
                testSource: LIMBS_GTEST,
                name: "Limbs",
                tempPrefix: "limbs-diff-",
            });

            const mine = await compileContractWithTypeScript({
                source: LIMBS,
                contractName: "Limbs",
                slot: 28,
                qpiHeader: HEADERS(),
                arenaSizeBytes: 64 * 1024,
            });
            expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
            for (const r of results) {
                console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
            }
            expect(results.length).toBeGreaterThan(0);
            expect(results.every((r) => r.passed)).toBe(true);
        },
        120000,
    );
});
