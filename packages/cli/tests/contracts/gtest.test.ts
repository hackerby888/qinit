import { CORE_PATH } from "../../../../test-utils/paths";
// End-to-end standard gtest: the same contract_testing.h source is compiled into a Wasm runner and drives a
// separately deployed contract on an isolated Virtual Node. Covers pass, fixture isolation, and reporting.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { buildContract, buildCorpusRunner } from "@qinit/build";
import { runContractTesting } from "@qinit/engine";

const CORE = CORE_PATH;
const CONTRACT = `${import.meta.dir}/../../../../fixtures/Counter.h`;
const have = existsSync(`${CORE}/test/contract_testing.h`) && existsSync(CONTRACT);

const TEST_SOURCE = `#define NO_UEFI
#include "contract_testing.h"

class ContractTestingCounter : protected ContractTesting {
public:
    ContractTestingCounter() {
        initEmptySpectrum();
        initEmptyUniverse();
        INIT_CONTRACT(Counter);
        callSystemProcedure(Counter_CONTRACT_INDEX, INITIALIZE);
    }
    Counter::Get_output get() const {
        Counter::Get_input input{};
        Counter::Get_output output{};
        callFunction(Counter_CONTRACT_INDEX, 1, input, output);
        return output;
    }
    void inc(const id& user) {
        Counter::Inc_input input{};
        Counter::Inc_output output{};
        invokeUserProcedure(Counter_CONTRACT_INDEX, 1, input, output, user, 0);
    }
};

TEST(Counter, IncrementsTwice) {
    ContractTestingCounter t;
    const id user = id::randomValue();
    increaseEnergy(user, 1000000000);
    EXPECT_EQ(t.get().value, 0ull);
    t.inc(user);
    t.inc(user);
    EXPECT_EQ(t.get().value, 2ull);
}
TEST(Counter, FreshStatePerTest) {
    ContractTestingCounter t;
    EXPECT_EQ(t.get().value, 0ull);
}
TEST(Counter, ReportsFailures) {
    ContractTestingCounter t;
    EXPECT_EQ(t.get().value, 7ull);
}
`;

test.skipIf(!have)(
  "a core-lite-style gtest runs in the engine (pass, isolation, captured failure)",
  async () => {
    const outDir = "/tmp/qinit-gtest-test";
    const testPath = `${outDir}/Counter.test.cpp`;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(testPath, TEST_SOURCE);

    const runner = await buildCorpusRunner({
      corpusPath: testPath,
      contractPath: CONTRACT,
      name: "Counter",
      stateType: "Counter",
      slot: 1,
      corePath: CORE,
      outDir: `${outDir}/runner`,
      arenaSz: 64 * 1024 * 1024,
    });
    expect(runner.ok, runner.stderr).toBe(true);

    const contract = await buildContract({
      contractPath: CONTRACT,
      name: "Counter",
      slot: 1,
      corePath: CORE,
      outDir: `${outDir}/contract`,
      skipVerify: true,
      arenaSz: 64 * 1024 * 1024,
    });
    expect(contract.ok, contract.stderr).toBe(true);

    const results = await runContractTesting(
      new Uint8Array(await Bun.file(runner.so!).arrayBuffer()),
      { 1: new Uint8Array(await Bun.file(contract.so!).arrayBuffer()) },
    );
    const by = Object.fromEntries(results.map((result) => [result.name, result]));
    expect(by["Counter.IncrementsTwice"]?.passed).toBe(true);
    expect(by["Counter.FreshStatePerTest"]?.passed).toBe(true);
    expect(by["Counter.ReportsFailures"]?.passed).toBe(false);
    expect(by["Counter.ReportsFailures"]?.message).toContain("EXPECT_EQ");
  },
  120_000,
);
