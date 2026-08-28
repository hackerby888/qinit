import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Differential gtest for control flow. The other 40 differentials cover math and containers well but
// almost no branching: across their embedded C++ there is no `do…while`, no `continue`, no `&&`, no
// `||` and no nested loop. What coverage existed lived in edge/edge-audit-controlflow.test.ts, which
// compiled with Qinit, ran on Qinit's simulator and compared against hand-written constants — compiler
// and expectation could be wrong together. Here the gtest is built by clang and computes each expected
// value inline, so clang's codegen judges ours.
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, expect, beforeAll } from "bun:test";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

// Every loop bound is a literal, so no input can make one of these run long or forever.
const FLOW = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 unused; };
  struct R_input {}; struct R_output { uint64 value; };

  struct ForContinue_input {}; struct ForContinue_output { uint64 value; };
  struct ForContinue_locals { uint64 i; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(ForContinue) {
    locals.sum = 0;
    for (locals.i = 0; locals.i < 5; locals.i++) { if (locals.i == 2) continue; locals.sum += locals.i; }
    output.value = locals.sum;
  }

  struct WhileContinue_input {}; struct WhileContinue_output { uint64 value; };
  struct WhileContinue_locals { uint64 i; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(WhileContinue) {
    locals.i = 0; locals.sum = 0;
    while (locals.i < 5) { locals.i++; if (locals.i == 3) continue; locals.sum += locals.i; }
    output.value = locals.sum;
  }

  struct DoContinue_input {}; struct DoContinue_output { uint64 value; };
  struct DoContinue_locals { uint64 i; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(DoContinue) {
    locals.i = 0; locals.sum = 0;
    do { locals.i++; if (locals.i < 3) continue; locals.sum += locals.i; } while (locals.i < 4);
    output.value = locals.sum;
  }

  struct NestedLoops_input {}; struct NestedLoops_output { uint64 value; };
  struct NestedLoops_locals { uint64 i; uint64 j; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(NestedLoops) {
    locals.sum = 0;
    for (locals.i = 0; locals.i < 3; locals.i++) {
      for (locals.j = 0; locals.j < 4; locals.j++) {
        if (locals.j == 1) continue;
        if (locals.i == 2 && locals.j == 3) break;
        locals.sum += locals.i * 10 + locals.j;
      }
    }
    output.value = locals.sum;
  }

  struct DefaultInMiddle_input {}; struct DefaultInMiddle_output { uint64 value; };
  struct DefaultInMiddle_locals { uint64 matched; uint64 missing; uint64 x; uint64 y; };
  PUBLIC_FUNCTION_WITH_LOCALS(DefaultInMiddle) {
    locals.matched = 0; locals.missing = 0; locals.x = 3; locals.y = 2;
    switch (locals.x) { case 1: locals.matched = 10; break; default: locals.matched = 20; case 3: locals.matched += 3; break; }
    switch (locals.y) { case 1: locals.missing = 10; break; default: locals.missing = 20; case 3: locals.missing += 3; break; }
    output.value = locals.matched * 100 + locals.missing;
  }

  struct DanglingElse_input {}; struct DanglingElse_output { uint64 value; };
  struct DanglingElse_locals { uint64 value; };
  PUBLIC_FUNCTION_WITH_LOCALS(DanglingElse) {
    locals.value = 0;
    if (true)
      if (false) locals.value = 1;
      else locals.value = 2;
    if (false) locals.value = 4;
    else if (true) locals.value += 3;
    output.value = locals.value;
  }

  struct ShortCircuit_input {}; struct ShortCircuit_output { uint64 value; };
  struct ShortCircuit_locals { uint64 left; uint64 right; };
  PUBLIC_FUNCTION_WITH_LOCALS(ShortCircuit) {
    locals.left = 0; locals.right = 0;
    if (false && (++locals.left != 0)) locals.left = 9;
    if (true || (++locals.right != 0)) locals.right += 0;
    output.value = locals.left * 10 + locals.right;
  }

  struct SwitchSelectorOnce_input {}; struct SwitchSelectorOnce_output { uint64 value; };
  struct SwitchSelectorOnce_locals { uint64 selector; uint64 selected; };
  PUBLIC_FUNCTION_WITH_LOCALS(SwitchSelectorOnce) {
    locals.selector = 2; locals.selected = 0;
    switch (locals.selector++) { case 2: locals.selected = 7; break; default: locals.selected = 9; }
    output.value = locals.selected * 10 + locals.selector;
  }

  // break binds to the switch, not the enclosing loop — the loop must keep running.
  struct BreakInSwitch_input {}; struct BreakInSwitch_output { uint64 value; };
  struct BreakInSwitch_locals { uint64 i; uint64 sum; uint64 rounds; };
  PUBLIC_FUNCTION_WITH_LOCALS(BreakInSwitch) {
    locals.sum = 0; locals.rounds = 0;
    for (locals.i = 0; locals.i < 6; locals.i++) {
      switch (locals.i) {
        case 0: locals.sum += 1; break;
        case 3: locals.sum += 100; break;
        default: locals.sum += 10; break;
      }
      locals.rounds++;
    }
    output.value = locals.sum * 100 + locals.rounds;
  }

  // continue binds to the loop even from inside a switch, so the trailing add is skipped.
  struct ContinueInSwitch_input {}; struct ContinueInSwitch_output { uint64 value; };
  struct ContinueInSwitch_locals { uint64 i; uint64 sum; uint64 tail; };
  PUBLIC_FUNCTION_WITH_LOCALS(ContinueInSwitch) {
    locals.sum = 0; locals.tail = 0;
    for (locals.i = 0; locals.i < 6; locals.i++) {
      switch (locals.i) {
        case 2: continue;
        case 4: locals.sum += 50; break;
        default: locals.sum += 1; break;
      }
      locals.tail++;
    }
    output.value = locals.sum * 100 + locals.tail;
  }

  // The condition is re-evaluated every iteration, and the right side must stay unevaluated once the
  // left is false.
  struct ShortCircuitLoop_input {}; struct ShortCircuitLoop_output { uint64 value; };
  struct ShortCircuitLoop_locals { uint64 i; uint64 probes; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(ShortCircuitLoop) {
    locals.i = 0; locals.probes = 0; locals.sum = 0;
    while (locals.i < 4 && (++locals.probes) != 0) { locals.sum += locals.i; locals.i++; }
    output.value = locals.sum * 100 + locals.probes;
  }

  // A logical operator whose right side is itself a logical operator: the lowering hoists that into a
  // branch with a temporary instead of an inline if-expression, which is a separate code path.
  struct NestedLogical_input {}; struct NestedLogical_output { uint64 value; };
  struct NestedLogical_locals { uint64 a; uint64 b; uint64 c; uint64 hits; uint64 out; };
  PUBLIC_FUNCTION_WITH_LOCALS(NestedLogical) {
    locals.a = 1; locals.b = 0; locals.c = 1; locals.hits = 0; locals.out = 0;
    if (locals.a != 0 && (locals.b != 0 || (++locals.hits) != 0)) locals.out += 1;
    if (locals.b != 0 && (locals.c != 0 || (++locals.hits) != 0)) locals.out += 10;
    if (locals.a != 0 || (locals.c != 0 && (++locals.hits) != 0)) locals.out += 100;
    output.value = locals.out * 10 + locals.hits;
  }

  struct TripleNested_input {}; struct TripleNested_output { uint64 value; };
  struct TripleNested_locals { uint64 i; uint64 j; uint64 k; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(TripleNested) {
    locals.sum = 0;
    for (locals.i = 0; locals.i < 3; locals.i++) {
      for (locals.j = 0; locals.j < 3; locals.j++) {
        if (locals.j == 2) continue;
        for (locals.k = 0; locals.k < 3; locals.k++) {
          if (locals.k == 1) continue;
          if (locals.i == 2 && locals.k == 2) break;
          locals.sum += locals.i * 100 + locals.j * 10 + locals.k;
        }
      }
    }
    output.value = locals.sum;
  }

  struct DoWhileZero_input {}; struct DoWhileZero_output { uint64 value; };
  struct DoWhileZero_locals { uint64 runs; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(DoWhileZero) {
    locals.runs = 0; locals.sum = 0;
    do { locals.runs++; locals.sum += 7; } while (false);
    output.value = locals.sum * 10 + locals.runs;
  }

  struct ZeroIteration_input {}; struct ZeroIteration_output { uint64 value; };
  struct ZeroIteration_locals { uint64 i; uint64 forRuns; uint64 whileRuns; };
  PUBLIC_FUNCTION_WITH_LOCALS(ZeroIteration) {
    locals.forRuns = 0; locals.whileRuns = 0;
    for (locals.i = 5; locals.i < 5; locals.i++) locals.forRuns++;
    locals.i = 9;
    while (locals.i < 5) { locals.whileRuns++; locals.i++; }
    output.value = locals.forRuns * 10 + locals.whileRuns;
  }

  struct CommaUpdate_input {}; struct CommaUpdate_output { uint64 value; };
  struct CommaUpdate_locals { uint64 i; uint64 j; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(CommaUpdate) {
    locals.sum = 0;
    for (locals.i = 0, locals.j = 10; locals.i < 4; locals.i++, locals.j--) locals.sum += locals.i * locals.j;
    output.value = locals.sum;
  }

  struct TernaryInLogical_input {}; struct TernaryInLogical_output { uint64 value; };
  struct TernaryInLogical_locals { uint64 a; uint64 b; uint64 hits; uint64 out; };
  PUBLIC_FUNCTION_WITH_LOCALS(TernaryInLogical) {
    locals.a = 0; locals.b = 3; locals.hits = 0; locals.out = 0;
    if (locals.a != 0 && ((locals.b > 2) ? (++locals.hits) : 0) != 0) locals.out += 1;
    if (locals.b != 0 && ((locals.b > 2) ? (++locals.hits) : 0) != 0) locals.out += 10;
    output.value = locals.out * 10 + locals.hits;
  }

  // WASM has no arbitrary jump, so returning out of two loops is the case most likely to get the block
  // depth wrong.
  struct EarlyReturn_input {}; struct EarlyReturn_output { uint64 value; };
  struct EarlyReturn_locals { uint64 i; uint64 j; uint64 sum; };
  PUBLIC_FUNCTION_WITH_LOCALS(EarlyReturn) {
    locals.sum = 0;
    for (locals.i = 0; locals.i < 5; locals.i++) {
      for (locals.j = 0; locals.j < 5; locals.j++) {
        locals.sum += 1;
        if (locals.i == 2 && locals.j == 2) { output.value = locals.sum * 1000 + locals.i * 10 + locals.j; return; }
      }
    }
    output.value = 999999;
  }

  // Raw division by zero traps, so an eagerly evaluated right side faults the contract instead of
  // returning a plausible number. fidelity-edges uses the same probe for the ternary.
  struct LazyTrap_input { uint64 zero; }; struct LazyTrap_output { uint64 value; };
  struct LazyTrap_locals { uint64 out; };
  PUBLIC_FUNCTION_WITH_LOCALS(LazyTrap) {
    locals.out = 0;
    if (input.zero != 0 && (100 / input.zero) > 0) locals.out += 1;
    if (input.zero == 0 || (100 / input.zero) > 0) locals.out += 10;
    output.value = locals.out;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(ForContinue, 1);
    REGISTER_USER_FUNCTION(WhileContinue, 2);
    REGISTER_USER_FUNCTION(DoContinue, 3);
    REGISTER_USER_FUNCTION(NestedLoops, 4);
    REGISTER_USER_FUNCTION(DefaultInMiddle, 5);
    REGISTER_USER_FUNCTION(DanglingElse, 6);
    REGISTER_USER_FUNCTION(ShortCircuit, 7);
    REGISTER_USER_FUNCTION(SwitchSelectorOnce, 8);
    REGISTER_USER_FUNCTION(BreakInSwitch, 9);
    REGISTER_USER_FUNCTION(ContinueInSwitch, 10);
    REGISTER_USER_FUNCTION(ShortCircuitLoop, 11);
    REGISTER_USER_FUNCTION(NestedLogical, 12);
    REGISTER_USER_FUNCTION(TripleNested, 13);
    REGISTER_USER_FUNCTION(DoWhileZero, 14);
    REGISTER_USER_FUNCTION(ZeroIteration, 15);
    REGISTER_USER_FUNCTION(CommaUpdate, 16);
    REGISTER_USER_FUNCTION(TernaryInLogical, 17);
    REGISTER_USER_FUNCTION(EarlyReturn, 18);
    REGISTER_USER_FUNCTION(LazyTrap, 19);
  }
};`;

// Each reference is the same program written as plain C++ and compiled by clang, so the assertion
// compares two compilers on one source rather than our output against a number someone typed.
const FLOW_GTEST = coreGtest(
    "Flow",
    `static uint64 refForContinue() { uint64 s = 0; for (uint64 i = 0; i < 5; i++) { if (i == 2) continue; s += i; } return s; }
static uint64 refWhileContinue() { uint64 i = 0, s = 0; while (i < 5) { i++; if (i == 3) continue; s += i; } return s; }
static uint64 refDoContinue() { uint64 i = 0, s = 0; do { i++; if (i < 3) continue; s += i; } while (i < 4); return s; }
static uint64 refNestedLoops() {
  uint64 s = 0;
  for (uint64 i = 0; i < 3; i++) for (uint64 j = 0; j < 4; j++) { if (j == 1) continue; if (i == 2 && j == 3) break; s += i * 10 + j; }
  return s;
}
static uint64 refDefaultInMiddle() {
  uint64 m = 0, n = 0, x = 3, y = 2;
  switch (x) { case 1: m = 10; break; default: m = 20; case 3: m += 3; break; }
  switch (y) { case 1: n = 10; break; default: n = 20; case 3: n += 3; break; }
  return m * 100 + n;
}
static uint64 refDanglingElse() {
  uint64 v = 0;
  if (true) { if (false) v = 1; else v = 2; }
  if (false) v = 4; else if (true) v += 3;
  return v;
}
static uint64 refShortCircuit() {
  uint64 l = 0, r = 0;
  if (false && (++l != 0)) l = 9;
  if (true || (++r != 0)) r += 0;
  return l * 10 + r;
}
static uint64 refSwitchSelectorOnce() {
  uint64 sel = 2, out = 0;
  switch (sel++) { case 2: out = 7; break; default: out = 9; }
  return out * 10 + sel;
}
static uint64 refBreakInSwitch() {
  uint64 s = 0, rounds = 0;
  for (uint64 i = 0; i < 6; i++) {
    switch (i) { case 0: s += 1; break; case 3: s += 100; break; default: s += 10; break; }
    rounds++;
  }
  return s * 100 + rounds;
}
static uint64 refContinueInSwitch() {
  uint64 s = 0, tail = 0;
  for (uint64 i = 0; i < 6; i++) {
    switch (i) { case 2: continue; case 4: s += 50; break; default: s += 1; break; }
    tail++;
  }
  return s * 100 + tail;
}
static uint64 refShortCircuitLoop() {
  uint64 i = 0, probes = 0, s = 0;
  while (i < 4 && (++probes) != 0) { s += i; i++; }
  return s * 100 + probes;
}
static uint64 refNestedLogical() {
  uint64 a = 1, b = 0, c = 1, hits = 0, out = 0;
  if (a != 0 && (b != 0 || (++hits) != 0)) out += 1;
  if (b != 0 && (c != 0 || (++hits) != 0)) out += 10;
  if (a != 0 || (c != 0 && (++hits) != 0)) out += 100;
  return out * 10 + hits;
}
static uint64 refTripleNested() {
  uint64 s = 0;
  for (uint64 i = 0; i < 3; i++) for (uint64 j = 0; j < 3; j++) {
    if (j == 2) continue;
    for (uint64 k = 0; k < 3; k++) { if (k == 1) continue; if (i == 2 && k == 2) break; s += i * 100 + j * 10 + k; }
  }
  return s;
}
static uint64 refDoWhileZero() { uint64 runs = 0, s = 0; do { runs++; s += 7; } while (false); return s * 10 + runs; }
static uint64 refZeroIteration() {
  uint64 f = 0, w = 0, i = 0;
  for (i = 5; i < 5; i++) f++;
  i = 9; while (i < 5) { w++; i++; }
  return f * 10 + w;
}
static uint64 refCommaUpdate() { uint64 s = 0; for (uint64 i = 0, j = 10; i < 4; i++, j--) s += i * j; return s; }
static uint64 refTernaryInLogical() {
  uint64 a = 0, b = 3, hits = 0, out = 0;
  if (a != 0 && ((b > 2) ? (++hits) : 0) != 0) out += 1;
  if (b != 0 && ((b > 2) ? (++hits) : 0) != 0) out += 10;
  return out * 10 + hits;
}
static uint64 refEarlyReturn() {
  uint64 s = 0;
  for (uint64 i = 0; i < 5; i++) for (uint64 j = 0; j < 5; j++) { s += 1; if (i == 2 && j == 2) return s * 1000 + i * 10 + j; }
  return 999999;
}

TEST(Flow, LoopsAndJumps) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::ForContinue_input in{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::ForContinue_output>(1, in).value, refForContinue());
  CONTRACT_STATE_TYPE::WhileContinue_input in2{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::WhileContinue_output>(2, in2).value, refWhileContinue());
  CONTRACT_STATE_TYPE::DoContinue_input in3{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::DoContinue_output>(3, in3).value, refDoContinue());
  CONTRACT_STATE_TYPE::NestedLoops_input in4{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::NestedLoops_output>(4, in4).value, refNestedLoops());
  CONTRACT_STATE_TYPE::TripleNested_input in13{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::TripleNested_output>(13, in13).value, refTripleNested());
  CONTRACT_STATE_TYPE::DoWhileZero_input in14{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::DoWhileZero_output>(14, in14).value, refDoWhileZero());
  CONTRACT_STATE_TYPE::ZeroIteration_input in15{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::ZeroIteration_output>(15, in15).value, refZeroIteration());
  CONTRACT_STATE_TYPE::CommaUpdate_input in16{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::CommaUpdate_output>(16, in16).value, refCommaUpdate());
  CONTRACT_STATE_TYPE::EarlyReturn_input in18{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::EarlyReturn_output>(18, in18).value, refEarlyReturn());
}

TEST(Flow, SwitchBinding) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::DefaultInMiddle_input in5{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::DefaultInMiddle_output>(5, in5).value, refDefaultInMiddle());
  CONTRACT_STATE_TYPE::SwitchSelectorOnce_input in8{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::SwitchSelectorOnce_output>(8, in8).value, refSwitchSelectorOnce());
  CONTRACT_STATE_TYPE::BreakInSwitch_input in9{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::BreakInSwitch_output>(9, in9).value, refBreakInSwitch());
  CONTRACT_STATE_TYPE::ContinueInSwitch_input in10{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::ContinueInSwitch_output>(10, in10).value, refContinueInSwitch());
}

TEST(Flow, ShortCircuitAndBranching) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::DanglingElse_input in6{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::DanglingElse_output>(6, in6).value, refDanglingElse());
  CONTRACT_STATE_TYPE::ShortCircuit_input in7{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::ShortCircuit_output>(7, in7).value, refShortCircuit());
  CONTRACT_STATE_TYPE::ShortCircuitLoop_input in11{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::ShortCircuitLoop_output>(11, in11).value, refShortCircuitLoop());
  CONTRACT_STATE_TYPE::NestedLogical_input in12{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::NestedLogical_output>(12, in12).value, refNestedLogical());
  CONTRACT_STATE_TYPE::TernaryInLogical_input in17{};
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::TernaryInLogical_output>(17, in17).value, refTernaryInLogical());

  // zero divisor: reaching either right-hand side divides by zero and traps.
  CONTRACT_STATE_TYPE::LazyTrap_input in19{};
  in19.zero = 0;
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::LazyTrap_output>(19, in19).value, 10ull);
  in19.zero = 4;
  EXPECT_EQ(t.call<CONTRACT_STATE_TYPE::LazyTrap_output>(19, in19).value, 11ull);
}
`,
);

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("differential gtest — control flow (loops, switch, short-circuit)", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "my control-flow contract agrees with clang on every shape",
        wasi,
        async () => {
            const runnerWasm = await buildDifferentialRunner({
                corePath: CORE,
                source: FLOW,
                testSource: FLOW_GTEST,
                name: "Flow",
                tempPrefix: "flow-diff-",
            });

            const mine = await compileContractWithTypeScript({
                source: FLOW,
                contractName: "Flow",
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
