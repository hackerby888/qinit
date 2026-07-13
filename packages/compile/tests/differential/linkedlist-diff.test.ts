import { CORE_PATH } from "../../../../test-utils/paths";
// Differential gtest for LinkedList<T, L> compiled from the real qpi.h body: addHead/addTail, insertAfter/insertBefore, forward and backward traversal (headIndex/tailIndex/nextElementIndex/
import { coreGtest } from "../support/core-gtest";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, test, expect, beforeAll } from "bun:test";
import { buildCorpusRunner } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const QUEUE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Job { uint64 amount; uint64 tag; };
  struct StateData { LinkedList<Job, 64> jobs; };
  struct Push_input { uint64 amount; uint64 tag; sint64 where; sint64 at; };
  struct Push_output { sint64 idx; };
  struct Push_locals { Job j; };
  struct Remove_input { sint64 idx; }; struct Remove_output {};
  struct Replace_input { sint64 idx; uint64 amount; uint64 tag; };
  struct Replace_output { sint64 ok; };
  struct Replace_locals { Job j; };
  struct Scan_input {};
  struct Scan_output {
    uint64 fwdAmt; uint64 fwdTagChain; uint64 revTagChain; uint64 pop; uint64 cap;
    sint64 headIdx; sint64 tailIdx; sint64 emptyAt0; sint64 emptyAt63;
  };
  struct Scan_locals { sint64 idx; };
  struct Reset_input {}; struct Reset_output {};
  PUBLIC_PROCEDURE_WITH_LOCALS(Push) {
    locals.j.amount = input.amount;
    locals.j.tag = input.tag;

    if (input.where == 0) {
      output.idx = state.mut().jobs.addTail(locals.j);
    } else if (input.where == 1) {
      output.idx = state.mut().jobs.addHead(locals.j);
    } else if (input.where == 2) {
      output.idx = state.mut().jobs.insertAfter(input.at, locals.j);
    } else {
      output.idx = state.mut().jobs.insertBefore(input.at, locals.j);
    }
  }
  PUBLIC_PROCEDURE(Remove) { state.mut().jobs.remove(input.idx); }
  PUBLIC_PROCEDURE_WITH_LOCALS(Replace) {
    locals.j.amount = input.amount;
    locals.j.tag = input.tag;
    output.ok = state.mut().jobs.replace(input.idx, locals.j) ? 1 : 0;
  }
  PUBLIC_FUNCTION_WITH_LOCALS(Scan) {
    locals.idx = state.get().jobs.headIndex();
    while (locals.idx >= 0) {
      output.fwdAmt += state.get().jobs.element(locals.idx).amount;
      output.fwdTagChain = output.fwdTagChain * 10 + state.get().jobs.element(locals.idx).tag;
      locals.idx = state.get().jobs.nextElementIndex(locals.idx);
    }

    locals.idx = state.get().jobs.tailIndex();
    while (locals.idx >= 0) {
      output.revTagChain = output.revTagChain * 10 + state.get().jobs.element(locals.idx).tag;
      locals.idx = state.get().jobs.prevElementIndex(locals.idx);
    }

    output.pop = state.get().jobs.population();
    output.cap = state.get().jobs.capacity();
    output.headIdx = state.get().jobs.headIndex();
    output.tailIdx = state.get().jobs.tailIndex();
    output.emptyAt0 = state.get().jobs.isEmptySlot(0) ? 1 : 0;
    output.emptyAt63 = state.get().jobs.isEmptySlot(63) ? 1 : 0;
  }
  PUBLIC_PROCEDURE(Reset) { state.mut().jobs.reset(); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Push, 1);
    REGISTER_USER_PROCEDURE(Remove, 2);
    REGISTER_USER_PROCEDURE(Replace, 3);
    REGISTER_USER_PROCEDURE(Reset, 4);
    REGISTER_USER_FUNCTION(Scan, 1);
  }
};`;

const QUEUE_GTEST = coreGtest(
  "Queue",
  `TEST(LinkedList, AddInsertTraverseRemove) {
  ContractTestingHarness t;
  QPI::id u1 = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(u1, 1000000000ll);
  CONTRACT_STATE_TYPE::Push_input p{};

  // Build 1,2,3 via tail appends, then wrap with addHead and targeted inserts.
  p.where = 0; p.amount = 10; p.tag = 1;
  sint64 first = t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1).idx;
  p.amount = 20; p.tag = 2;
  sint64 mid = t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1).idx;
  p.amount = 30; p.tag = 3; t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1);
  p.where = 1; p.amount = 40; p.tag = 4; t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1);
  p.where = 2; p.at = mid; p.amount = 50; p.tag = 5; t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1);
  p.where = 3; p.at = first; p.amount = 60; p.tag = 6; t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1);

  // List order now: 4 6 1 2 5 3.
  CONTRACT_STATE_TYPE::Scan_input s{};
  CONTRACT_STATE_TYPE::Scan_output r = t.call<CONTRACT_STATE_TYPE::Scan_output>(1, s);
  EXPECT_EQ(r.fwdAmt, 210ull);
  EXPECT_EQ(r.fwdTagChain, 461253ull);
  EXPECT_EQ(r.revTagChain, 352164ull);
  EXPECT_EQ(r.pop, 6ull);
  EXPECT_EQ(r.cap, 64ull);
  EXPECT_EQ(r.emptyAt0, 0ll);
  EXPECT_EQ(r.emptyAt63, 1ll);

  // Remove the middle element, then head and tail; traversal must re-link both ways.
  CONTRACT_STATE_TYPE::Remove_input rm{}; rm.idx = mid;
  t.invoke<CONTRACT_STATE_TYPE::Remove_output>(2, rm, 0, u1);
  CONTRACT_STATE_TYPE::Scan_output r2 = t.call<CONTRACT_STATE_TYPE::Scan_output>(1, s);
  EXPECT_EQ(r2.fwdTagChain, 46153ull);
  EXPECT_EQ(r2.revTagChain, 35164ull);
  EXPECT_EQ(r2.pop, 5ull);

  // The freed node must be recycled by the next add (free list before unused pool).
  p.where = 0; p.at = 0; p.amount = 70; p.tag = 7;
  sint64 reused = t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1).idx;
  EXPECT_EQ(reused, mid);
  CONTRACT_STATE_TYPE::Scan_output r3 = t.call<CONTRACT_STATE_TYPE::Scan_output>(1, s);
  EXPECT_EQ(r3.fwdTagChain, 461537ull);
  EXPECT_EQ(r3.pop, 6ull);

  // replace swaps the payload in place without touching links.
  CONTRACT_STATE_TYPE::Replace_input rp{}; rp.idx = first; rp.amount = 11; rp.tag = 9;
  EXPECT_EQ((t.invoke<CONTRACT_STATE_TYPE::Replace_output>(3, rp, 0, u1).ok), 1ll);
  rp.idx = 63;
  EXPECT_EQ((t.invoke<CONTRACT_STATE_TYPE::Replace_output>(3, rp, 0, u1).ok), 0ll);
  CONTRACT_STATE_TYPE::Scan_output r4 = t.call<CONTRACT_STATE_TYPE::Scan_output>(1, s);
  EXPECT_EQ(r4.fwdTagChain, 469537ull);
  EXPECT_EQ(r4.fwdAmt, 261ull);
}

TEST(LinkedList, ResetAndReuse) {
  ContractTestingHarness t;
  QPI::id u1 = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(u1, 1000000000ll);
  CONTRACT_STATE_TYPE::Push_input p{}; p.where = 0;
  p.amount = 10; p.tag = 1; t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1);
  p.amount = 20; p.tag = 2; t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1);

  CONTRACT_STATE_TYPE::Reset_input rs{};
  t.invoke<CONTRACT_STATE_TYPE::Reset_output>(4, rs, 0, u1);
  CONTRACT_STATE_TYPE::Scan_input s{};
  CONTRACT_STATE_TYPE::Scan_output r = t.call<CONTRACT_STATE_TYPE::Scan_output>(1, s);
  EXPECT_EQ(r.pop, 0ull);
  EXPECT_EQ(r.headIdx, -1ll);
  EXPECT_EQ(r.tailIdx, -1ll);
  EXPECT_EQ(r.fwdAmt, 0ull);
  EXPECT_EQ(r.emptyAt0, 1ll);

  // Post-reset adds start from a clean pool at index 0 again.
  p.amount = 30; p.tag = 3;
  sint64 idx = t.invoke<CONTRACT_STATE_TYPE::Push_output>(1, p, 0, u1).idx;
  EXPECT_EQ(idx, 0ll);
  CONTRACT_STATE_TYPE::Scan_output r2 = t.call<CONTRACT_STATE_TYPE::Scan_output>(1, s);
  EXPECT_EQ(r2.pop, 1ull);
  EXPECT_EQ(r2.fwdTagChain, 3ull);
}
`,
);

const wasi = wasiToolchain();

describe("differential gtest — LinkedList (add/insert/traverse/remove/reset)", () => {
  beforeAll(async () => {
    await initK12();
  });

  toolchainTest(
    "my LinkedList contract passes the native LinkedList gtest",
    wasi,
    async () => {
      const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "linkedlist-diff-"));
      const contractPath = join(dir, "Queue.h");
      writeFileSync(contractPath, QUEUE);

      const testPath = join(dir, "Queue.test.cpp");
      writeFileSync(testPath, QUEUE_GTEST);
      const built = await buildCorpusRunner({
        corpusPath: testPath,
        contractPath,
        name: "Queue",
        stateType: "Queue",
        slot: 28,
        corePath: CORE,
        outDir: dir,
      });
      expect(built.ok).toBe(true);
      const runnerWasm = new Uint8Array(readFileSync(built.so!));

      const mine = await compileContract({
        source: QUEUE,
        name: "Queue",
        slot: 28,
        qpiHeader: HEADERS,
        arenaSz: 1024 * 1024,
      });
      expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

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
