import { CORE_PATH } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { runCompiledGtest } from "@qinit/engine";
import { compileContract, compileGtest, loadQpiHeader } from "../../src";

const CORE = CORE_PATH;
const QPI = loadQpiHeader(CORE);

const CONTRACT = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; };
  struct Inc_input {}; struct Inc_output {};
  struct Add_input { uint64 delta; }; struct Add_output {};
  struct Get_input {}; struct Get_output { uint64 value; uint64 doubleValue; };
  PUBLIC_PROCEDURE(Inc) { state.mut().counter += 1; }
  PUBLIC_PROCEDURE(Add) { state.mut().counter += input.delta; }
  PUBLIC_FUNCTION(Get) { output.value = state.get().counter; output.doubleValue = state.get().counter * 2; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Inc, 1);
    REGISTER_USER_PROCEDURE(Add, 2);
    REGISTER_USER_FUNCTION(Get, 1);
  }
};`;

const STANDARD_GTEST = `#define NO_UEFI
#include "contract_testing.h"

class ContractTestingCounter : protected ContractTesting {
public:
  ContractTestingCounter() {
    initEmptySpectrum();
    initEmptyUniverse();
    INIT_CONTRACT(Counter);
    callSystemProcedure(Counter_CONTRACT_INDEX, INITIALIZE);
  }
  void fund(const id& account, uint64 amount) { increaseEnergy(account, amount); }
  Counter::Inc_output inc(const id& user, sint64 amount = 0) {
    Counter::Inc_input in{};
    Counter::Inc_output out{};
    invokeUserProcedure(Counter_CONTRACT_INDEX, 1, in, out, user, amount);
    return out;
  }
  Counter::Get_output get() const {
    Counter::Get_output out{};
    callFunction(Counter_CONTRACT_INDEX, 1, Counter::Get_input(), out);
    return out;
  }
  void add(const id& user, uint64 delta) {
    Counter::Add_input input{};
    input.delta = delta;
    Counter::Add_output output{};
    invokeUserProcedure(Counter_CONTRACT_INDEX, 2, input, output, user, 0);
  }
};

TEST(Counter, Increment) {
  ContractTestingCounter t;
  const id user = id::randomValue();
  t.fund(user, 1000000000);
  Counter::Inc_output out = t.inc(user);
  (void)out;
  EXPECT_EQ(((Counter::StateData*)contractStates[Counter_CONTRACT_INDEX])->counter, 1ull);
  t.inc(user);
  Counter::Get_output got = t.get();
  EXPECT_TRUE(got.value);
  EXPECT_EQ(got.value, 2ull);
  EXPECT_EQ(got.value + got.doubleValue, 6ull);
  EXPECT_EQ(got.value + 1ull, 3ull);
  EXPECT_EQ(t.get().value, 2ull) << "direct fixture call";
  t.add(user, 5);
  EXPECT_EQ(t.get().value, 7ull);
}`;

describe("core-lite-style gtest compiler", () => {
  beforeAll(async () => initK12());

  test("compiles and executes a standard ContractTesting test without clang", async () => {
    const compiled = await compileGtest({
      source: CONTRACT,
      testSource: STANDARD_GTEST,
      name: "Counter",
      slot: 28,
      qpiHeader: QPI,
    });
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(compiled.program?.tests.map((item) => item.name)).toEqual(["Counter.Increment"]);

    const contract = await compileContract({
      source: CONTRACT,
      name: "Counter",
      slot: 28,
      qpiHeader: QPI,
      arenaSz: 64 * 1024,
    });
    expect(contract.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const results = await runCompiledGtest(compiled.program!, compiled.wasm!, {
      28: contract.wasm,
    });
    expect(results).toEqual([{ name: "Counter.Increment", passed: true, message: "" }]);
  }, 120000);

  test("rejects the removed ContractTest style", async () => {
    const compiled = await compileGtest({
      source: CONTRACT,
      testSource: `TEST(Counter, Old) { ContractTest t; }`,
      name: "Counter",
      slot: 28,
      qpiHeader: QPI,
    });
    expect(compiled.program).toBeUndefined();
    expect(compiled.diagnostics[0]?.message).toContain("legacy ContractTest");
  });

  test("compiles loops through the normal frontend", async () => {
    const compiled = await compileGtest({
      source: CONTRACT,
      testSource: STANDARD_GTEST.replace(
        "Counter::Inc_output out = t.inc(user);",
        "for (int i = 0; i < 3; ++i) { t.inc(user); }",
      ),
      name: "Counter",
      slot: 28,
      qpiHeader: QPI,
    });
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(compiled.program).toBeDefined();
  });

  test("reports a failed compiler-backed assertion", async () => {
    const compiled = await compileGtest({
      source: CONTRACT,
      testSource: STANDARD_GTEST.replace(
        "EXPECT_EQ(t.get().value, 7ull);",
        "EXPECT_EQ(t.get().value, 8ull);",
      ),
      name: "Counter",
      slot: 28,
      qpiHeader: QPI,
    });
    const contract = await compileContract({
      source: CONTRACT,
      name: "Counter",
      slot: 28,
      qpiHeader: QPI,
      arenaSz: 64 * 1024,
    });
    const [result] = await runCompiledGtest(compiled.program!, compiled.wasm!, {
      28: contract.wasm,
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("EXPECT_EQ failed");
  });
});
