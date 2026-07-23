import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Differential coverage for Collection mutation and per-PoV traversal.
import { coreGtest } from "../support/core-gtest";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, test, expect, beforeAll } from "bun:test";
import { buildCorpusRunner } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const ORDERS = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Order { uint64 amount; uint64 tag; };
  struct StateData { Collection<Order, 1024> orders; };
  struct Add_input { id pov; uint64 amount; uint64 tag; sint64 priority; }; struct Add_output { sint64 idx; };
  struct Add_locals { Order o; };
  struct Remove_input { sint64 idx; }; struct Remove_output {};
  struct Sum_input { id pov; }; struct Sum_output { uint64 amt; uint64 tag; uint64 pop; };
  struct Sum_locals { sint64 idx; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Add) {
    locals.o.amount = input.amount;
    locals.o.tag = input.tag;
    output.idx = state.mut().orders.add(input.pov, locals.o, input.priority);
  }
  PUBLIC_PROCEDURE(Remove) { state.mut().orders.remove(input.idx); }
  PUBLIC_FUNCTION_WITH_LOCALS(Sum) {
    locals.idx = state.get().orders.headIndex(input.pov);
    while (locals.idx >= 0) {
      output.amt += state.get().orders.element(locals.idx).amount;
      output.tag += state.get().orders.element(locals.idx).tag;
      locals.idx = state.get().orders.nextElementIndex(locals.idx);
    }
    output.pop = state.get().orders.population();
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Add, 1);
    REGISTER_USER_PROCEDURE(Remove, 2);
    REGISTER_USER_FUNCTION(Sum, 1);
  }
};`;

const ORDERS_GTEST = coreGtest(
  "Orders",
  `TEST(Coll, AddIterateRemove) {
  ContractTestingHarness t;
  QPI::id u1 = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  QPI::id u2 = t.idFromSeed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  t.fund(u1, 1000000000ll);
  CONTRACT_STATE_TYPE::Add_input a{}; a.pov = u1;
  a.amount = 100; a.tag = 1; a.priority = 5; t.invoke<CONTRACT_STATE_TYPE::Add_output>(1, a, 0, u1);
  a.amount = 50;  a.tag = 2; a.priority = 3;
  sint64 mid = t.invoke<CONTRACT_STATE_TYPE::Add_output>(1, a, 0, u1).idx;
  a.amount = 25;  a.tag = 4; a.priority = 9; t.invoke<CONTRACT_STATE_TYPE::Add_output>(1, a, 0, u1);
  // a different pov's element must not leak into u1's queue
  a.pov = u2; a.amount = 999; a.tag = 8; a.priority = 1; t.invoke<CONTRACT_STATE_TYPE::Add_output>(1, a, 0, u1);

  CONTRACT_STATE_TYPE::Sum_input s{}; s.pov = u1;
  CONTRACT_STATE_TYPE::Sum_output r = t.call<CONTRACT_STATE_TYPE::Sum_output>(1, s);
  EXPECT_EQ(r.amt, 175ull);   // 100 + 50 + 25 (u2's 999 excluded)
  EXPECT_EQ(r.tag, 7ull);     // 1 + 2 + 4
  EXPECT_EQ(r.pop, 4ull);     // total population across all povs

  CONTRACT_STATE_TYPE::Remove_input rm{}; rm.idx = mid;
  t.invoke<CONTRACT_STATE_TYPE::Remove_output>(2, rm, 0, u1);
  CONTRACT_STATE_TYPE::Sum_output r2 = t.call<CONTRACT_STATE_TYPE::Sum_output>(1, s);
  EXPECT_EQ(r2.amt, 125ull);  // 175 - 50
  EXPECT_EQ(r2.tag, 5ull);    // 7 - 2
  EXPECT_EQ(r2.pop, 3ull);
}
`,
);

const wasi = wasiToolchain();

describe("differential gtest — Collection (BST add/iterate/remove)", () => {
  beforeAll(async () => {
    await initK12();
  });

  toolchainTest(
    "my Collection contract passes the native Collection gtest",
    wasi,
    async () => {
      const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "collection-diff-"));
      const contractPath = join(dir, "Orders.h");
      writeFileSync(contractPath, ORDERS);

      const testPath = join(dir, "Orders.test.cpp");
      writeFileSync(testPath, ORDERS_GTEST);
      const built = await buildCorpusRunner({
        corpusPath: testPath,
        contractPath,
        name: "Orders",
        stateType: "Orders",
        slot: 28,
        corePath: CORE,
        outDir: dir,
      });
      expect(built.ok).toBe(true);
      const runnerWasm = new Uint8Array(readFileSync(built.so!));

      const mine = await compileContract({
        source: ORDERS,
        name: "Orders",
        slot: 28,
        qpiHeader: HEADERS,
        arenaSz: 1024 * 1024,
      });
      expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

      const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
      for (const r of results) {
        console.log(
          `  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`,
        );
      }
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.passed)).toBe(true);
    },
    120000,
  );
});
