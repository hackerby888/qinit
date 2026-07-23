import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Differential coverage for HashSet/HashMap removal and iteration methods.
import { coreGtest } from "../support/core-gtest";
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildCorpusRunner } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const REGISTRY = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    HashSet<id, 1024> members;
    HashMap<id, uint64, 1024> bal;
  };
  struct Join_input {}; struct Join_output {};
  struct Leave_input {}; struct Leave_output {};
  struct IsMember_input { id who; }; struct IsMember_output { uint64 yes; };
  struct Count_input {}; struct Count_output { uint64 n; };
  struct Deposit_input { uint64 amt; }; struct Deposit_output {};
  struct RemoveBal_input { id who; }; struct RemoveBal_output {};
  struct SumAll_input {}; struct SumAll_output { uint64 sum; };
  struct SumAll_locals { sint64 idx; uint64 sum; };

  PUBLIC_PROCEDURE(Join) { state.mut().members.add(qpi.invocator()); }
  PUBLIC_PROCEDURE(Leave) { state.mut().members.remove(qpi.invocator()); }
  PUBLIC_FUNCTION(IsMember) { output.yes = state.get().members.contains(input.who) ? 1 : 0; }
  PUBLIC_FUNCTION(Count) { output.n = state.get().members.population(); }

  PUBLIC_PROCEDURE(Deposit) { state.mut().bal.set(qpi.invocator(), input.amt); }
  PUBLIC_PROCEDURE(RemoveBal) { state.mut().bal.removeByKey(input.who); }
  PUBLIC_FUNCTION_WITH_LOCALS(SumAll) {
    locals.sum = 0;
    locals.idx = state.get().bal.nextElementIndex(-1);
    while (locals.idx >= 0) {
      locals.sum += state.get().bal.value(locals.idx);
      locals.idx = state.get().bal.nextElementIndex(locals.idx);
    }
    output.sum = locals.sum;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Join, 1);
    REGISTER_USER_PROCEDURE(Leave, 2);
    REGISTER_USER_FUNCTION(IsMember, 1);
    REGISTER_USER_FUNCTION(Count, 2);
    REGISTER_USER_PROCEDURE(Deposit, 3);
    REGISTER_USER_PROCEDURE(RemoveBal, 4);
    REGISTER_USER_FUNCTION(SumAll, 3);
  }
};
`;

const REGISTRY_GTEST = coreGtest(
  "Registry",
  `TEST(Registry, HashSetAddContainsRemovePopulation) {
  ContractTestingHarness t;
  QPI::id u1 = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  QPI::id u2 = t.idFromSeed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  QPI::id u3 = t.idFromSeed("ccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
  t.fund(u1, 1000000000ll); t.fund(u2, 1000000000ll);
  Registry::Join_input j{};
  t.invoke<Registry::Join_output>(1, j, 0, u1);
  t.invoke<Registry::Join_output>(1, j, 0, u2);
  Registry::Count_input ci{};
  EXPECT_EQ(t.call<Registry::Count_output>(2, ci).n, 2ull);
  Registry::IsMember_input m{}; m.who = u1;
  EXPECT_EQ(t.call<Registry::IsMember_output>(1, m).yes, 1ull);
  m.who = u3;
  EXPECT_EQ(t.call<Registry::IsMember_output>(1, m).yes, 0ull);
  Registry::Leave_input l{};
  t.invoke<Registry::Leave_output>(2, l, 0, u1);
  EXPECT_EQ(t.call<Registry::Count_output>(2, ci).n, 1ull);
  m.who = u1;
  EXPECT_EQ(t.call<Registry::IsMember_output>(1, m).yes, 0ull);
}
TEST(Registry, HashMapIterateAndRemove) {
  ContractTestingHarness t;
  QPI::id u1 = t.idFromSeed("ddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
  QPI::id u2 = t.idFromSeed("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  t.fund(u1, 1000000000ll); t.fund(u2, 1000000000ll);
  Registry::Deposit_input d{}; d.amt = 100ull;
  t.invoke<Registry::Deposit_output>(3, d, 0, u1);
  d.amt = 50ull;
  t.invoke<Registry::Deposit_output>(3, d, 0, u2);
  Registry::SumAll_input s{};
  EXPECT_EQ(t.call<Registry::SumAll_output>(3, s).sum, 150ull);
  Registry::RemoveBal_input rb{}; rb.who = u1;
  t.invoke<Registry::RemoveBal_output>(4, rb, 0, u1);
  EXPECT_EQ(t.call<Registry::SumAll_output>(3, s).sum, 50ull);
}
TEST(Registry, HashMapReuseRemovedSlot) {
  ContractTestingHarness t;
  QPI::id u1 = t.idFromSeed("fffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  t.fund(u1, 1000000000ll);
  Registry::Deposit_input d{}; d.amt = 100ull;
  t.invoke<Registry::Deposit_output>(3, d, 0, u1);
  Registry::RemoveBal_input rb{}; rb.who = u1;
  t.invoke<Registry::RemoveBal_output>(4, rb, 0, u1);
  d.amt = 200ull;
  t.invoke<Registry::Deposit_output>(3, d, 0, u1);   // Reinsert the key so the set reuses its removal slot.
  Registry::SumAll_input s{};                          // marked for removal and takes goto reuse_slot
  EXPECT_EQ(t.call<Registry::SumAll_output>(3, s).sum, 200ull);
}
`,
);

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — Registry (HashSet + HashMap iteration/remove)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Registry.wasm passes the native Registry gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "registry-diff-"));
    const contractPath = join(dir, "Registry.h");
    writeFileSync(contractPath, REGISTRY);

    const testPath = join(dir, "Registry.test.cpp");
    writeFileSync(testPath, REGISTRY_GTEST);
    const built = await buildCorpusRunner({
      corpusPath: testPath,
      contractPath,
      name: "Registry",
      stateType: "Registry",
      slot: 28,
      corePath: CORE,
      outDir: dir,
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({
      source: REGISTRY,
      name: "Registry",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 1024 * 1024,
    });
    expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
