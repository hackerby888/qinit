import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Differential gtest validation: drive MY TS-compiled contract wasm with the SAME gtest cases that pin the native-clang build.
import { coreGtest } from "../support/core-gtest";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, expect, beforeAll } from "bun:test";
import { buildCorpusRunner } from "@qinit/build";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

const COUNTER = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; };
  struct Inc_input {}; struct Inc_output {};
  struct Get_input {}; struct Get_output { uint64 value; };
  PUBLIC_PROCEDURE(Inc) { state.mut().counter += 1; }
  PUBLIC_FUNCTION(Get) { output.value = state.get().counter; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Inc, 1);
    REGISTER_USER_FUNCTION(Get, 1);
  }
};
`;

const SINK = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 incoming; sint64 lastAmount; uint64 inits; uint64 pokes; sint64 lastReward; };
  struct Get_input {}; struct Get_output { uint64 incoming; sint64 lastAmount; uint64 inits; uint64 pokes; sint64 lastReward; };
  struct Poke_input { uint64 add; }; struct Poke_output { uint64 pokes; sint64 reward; };
  PUBLIC_FUNCTION(Get) {
    output.incoming = state.get().incoming;
    output.lastAmount = state.get().lastAmount;
    output.inits = state.get().inits;
    output.pokes = state.get().pokes;
    output.lastReward = state.get().lastReward;
  }
  PUBLIC_PROCEDURE(Poke) {
    state.mut().pokes += input.add;
    state.mut().lastReward = qpi.invocationReward();
    output.pokes = state.get().pokes;
    output.reward = qpi.invocationReward();
  }
  INITIALIZE() { state.mut().inits += 1; }
  POST_INCOMING_TRANSFER() {
    state.mut().incoming += 1;
    state.mut().lastAmount = input.amount;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Get, 1);
    REGISTER_USER_PROCEDURE(Poke, 1);
  }
};
`;

// Quottery's pattern from core's contract_quottery.cpp: move the qu by hand, then fire only the callback.
const SINK_GTEST = `#define NO_UEFI
#include "contract_testing.h"
class ContractTestingSink : protected ContractTesting {
public:
  ContractTestingSink() {
    initEmptySpectrum();
    initEmptyUniverse();
    INIT_CONTRACT(Sink);
  }
  Sink::Get_output get() const {
    Sink::Get_output output{};
    callFunction(Sink_CONTRACT_INDEX, 1, Sink::Get_input(), output);
    return output;
  }
  bool poke(const id& user, sint64 reward, Sink::Poke_output& output) {
    return invokeUserProcedure(Sink_CONTRACT_INDEX, 1, Sink::Poke_input{ 1 }, output, user, reward);
  }
};
TEST(Sink, IncomingTransferRunsOnlyTheCallback) {
  ContractTestingSink t;
  const id user = id::randomValue();
  const id contract(Sink_CONTRACT_INDEX, 0, 0, 0);
  increaseEnergy(user, 700);
  increaseEnergy(contract, 300);
  QpiContextSystemProcedureCall qpi(Sink_CONTRACT_INDEX, POST_INCOMING_TRANSFER);
  QPI::PostIncomingTransfer_input input{ user, 300, QPI::TransferType::standardTransaction };
  qpi.call(input);
  EXPECT_EQ(contractError[Sink_CONTRACT_INDEX], 0u);
  EXPECT_EQ(t.get().incoming, 1ull);
  EXPECT_EQ(t.get().lastAmount, 300ll);
  EXPECT_EQ(getBalance(contract), 300ll);
  EXPECT_EQ(getBalance(user), 700ll);
}
TEST(Sink, CallRunsAnInputlessSystemProcedure) {
  ContractTestingSink t;
  QpiContextSystemProcedureCall qpi(Sink_CONTRACT_INDEX, INITIALIZE);
  qpi.call();
  EXPECT_EQ(contractError[Sink_CONTRACT_INDEX], 0u);
  EXPECT_EQ(t.get().inits, 1ull);
  EXPECT_EQ(t.get().incoming, 0ull);
}
`;

// core's harness helpers move only the qu core moves: notifyContractOfIncomingTransfer and a hand-built
// QpiContextUserProcedureCall move none, invokeUserProcedure moves the reward, and decreaseEnergy refuses an overdraft.
const SINK_HELPERS_GTEST = `${SINK_GTEST.slice(0, SINK_GTEST.indexOf("TEST(Sink,"))}TEST(Sink, NotifyRunsOnlyTheCallback) {
  ContractTestingSink t;
  const id user = id::randomValue();
  const id contract(Sink_CONTRACT_INDEX, 0, 0, 0);
  notifyContractOfIncomingTransfer(user, contract, 300, QPI::TransferType::standardTransaction);
  EXPECT_EQ(t.get().incoming, 1ull);
  EXPECT_EQ(t.get().lastAmount, 300ll);
  EXPECT_EQ(getBalance(contract), 0ll);
  notifyContractOfIncomingTransfer(user, contract, 0, QPI::TransferType::standardTransaction);
  notifyContractOfIncomingTransfer(contract, user, 300, QPI::TransferType::standardTransaction);
  EXPECT_EQ(t.get().incoming, 1ull);
}
TEST(Sink, ProcedureContextRunsOnlyTheProcedure) {
  ContractTestingSink t;
  const id user = id::randomValue();
  const id contract(Sink_CONTRACT_INDEX, 0, 0, 0);
  QpiContextUserProcedureCall qpi(Sink_CONTRACT_INDEX, user, 500);
  Sink::Poke_input input{ 2 };
  qpi.call(1, &input, sizeof(input));
  EXPECT_EQ(contractError[Sink_CONTRACT_INDEX], 0u);
  ASSERT_EQ(qpi.outputSize, sizeof(Sink::Poke_output));
  const Sink::Poke_output output = *(const Sink::Poke_output*)qpi.outputBuffer;
  EXPECT_EQ(output.pokes, 2ull);
  EXPECT_EQ(output.reward, 500ll);
  EXPECT_EQ(t.get().incoming, 0ull);
  EXPECT_EQ(getBalance(contract), 0ll);
  qpi.freeBuffer();
  EXPECT_TRUE(qpi.outputBuffer == nullptr);
}
TEST(Sink, FunctionContextKeepsItsOutput) {
  ContractTestingSink t;
  QpiContextSystemProcedureCall(Sink_CONTRACT_INDEX, INITIALIZE).call();
  QpiContextUserFunctionCall qpi(Sink_CONTRACT_INDEX);
  Sink::Get_input input{};
  EXPECT_EQ(qpi.call(1, &input, sizeof(input)), 0u);
  ASSERT_EQ(qpi.outputSize, sizeof(Sink::Get_output));
  EXPECT_EQ(((const Sink::Get_output*)qpi.outputBuffer)->inits, 1ull);
}
TEST(Sink, InvokeMovesTheRewardThenRunsTheCallbackAndProcedure) {
  ContractTestingSink t;
  const id user = id::randomValue();
  const id contract(Sink_CONTRACT_INDEX, 0, 0, 0);
  increaseEnergy(user, 1000);
  Sink::Poke_output output{};
  EXPECT_TRUE(t.poke(user, 400, output));
  EXPECT_EQ(output.reward, 400ll);
  EXPECT_EQ(t.get().incoming, 1ull);
  EXPECT_EQ(t.get().lastAmount, 400ll);
  EXPECT_EQ(getBalance(contract), 400ll);
  EXPECT_EQ(getBalance(user), 600ll);
  EXPECT_FALSE(t.poke(user, 601, output));
  EXPECT_EQ(t.get().pokes, 1ull);
}
TEST(Sink, DecreaseEnergyRefusesAnOverdraft) {
  ContractTestingSink t;
  const id user = id::randomValue();
  increaseEnergy(user, 100);
  const int index = spectrumIndex(user);
  ASSERT_GE(index, 0);
  EXPECT_EQ(energy(index), 100ll);
  EXPECT_FALSE(decreaseEnergy(index, 101));
  EXPECT_FALSE(decreaseEnergy(index, -1));
  EXPECT_EQ(energy(index), 100ll);
  EXPECT_TRUE(decreaseEnergy(index, 40));
  EXPECT_EQ(energy(index), 60ll);
  EXPECT_EQ(getBalance(user), 60ll);
}
`;

// Core-lite-style gtest cases — the same assertions a native build validates.
const COUNTER_GTEST = coreGtest(
    "Counter",
    `TEST(Counter, StartsAtZero) {
  ContractTestingHarness t;
  Counter::Get_input in{};
  EXPECT_EQ(t.call<Counter::Get_output>(1, in).value, 0ull);
}
TEST(Counter, IncrementsAreCumulative) {
  ContractTestingHarness t;
  QPI::id user = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(user, 1000000000);
  Counter::Inc_input in{};
  for (int i = 0; i < 5; i++) t.invoke<Counter::Inc_output>(1, in, 0, user);
  Counter::Get_input g{};
  EXPECT_EQ(t.call<Counter::Get_output>(1, g).value, 5ull);  // read via Get (thost-mediated)
}
TEST(Counter, EachTestStartsFresh) {
  ContractTestingHarness t;
  Counter::Get_input g{};
  EXPECT_EQ(t.call<Counter::Get_output>(1, g).value, 0ull);
}
`,
);

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("differential gtest — my contract vs native test logic", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "my Counter.wasm passes the native Counter gtest",
        wasi,
        async () => {
            const { writeFileSync, mkdtempSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            const dir = mkdtempSync(join(tmpdir(), "gtest-diff-"));
            const contractPath = join(dir, "Counter.h");
            writeFileSync(contractPath, COUNTER);

            const testPath = join(dir, "Counter.test.cpp");
            writeFileSync(testPath, COUNTER_GTEST);
            const built = await buildCorpusRunner({
                corpusPath: testPath,
                contractPath,
                contractName: "Counter",
                stateType: "Counter",
                slot: 28,
                corePath: CORE,
                outDir: dir,
            });
            expect(built.ok, built.stderr).toBe(true);
            const runnerWasm = new Uint8Array(await (await import("node:fs/promises")).readFile(built.wasmPath!));

            const mine = await compileContractWithTypeScript({
                source: COUNTER,
                contractName: "Counter",
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

    // core's own tests move the qu and then fire the callback through QpiContextSystemProcedureCall (Quottery does);
    // the callback has to see the amount while no second credit lands on the contract.
    toolchainTest(
        "QpiContextSystemProcedureCall runs system procedures the way core's tests call them",
        wasi,
        async () => {
            const results = await runSinkGtest(SINK_GTEST);
            expect(results).toEqual([
                { name: "Sink.IncomingTransferRunsOnlyTheCallback", passed: true, message: "" },
                { name: "Sink.CallRunsAnInputlessSystemProcedure", passed: true, message: "" },
            ]);
        },
        120000,
    );

    toolchainTest(
        "core's harness helpers move only the qu core moves",
        wasi,
        async () => {
            const results = await runSinkGtest(SINK_HELPERS_GTEST);
            expect(results).toEqual([
                { name: "Sink.NotifyRunsOnlyTheCallback", passed: true, message: "" },
                { name: "Sink.ProcedureContextRunsOnlyTheProcedure", passed: true, message: "" },
                { name: "Sink.FunctionContextKeepsItsOutput", passed: true, message: "" },
                { name: "Sink.InvokeMovesTheRewardThenRunsTheCallbackAndProcedure", passed: true, message: "" },
                { name: "Sink.DecreaseEnergyRefusesAnOverdraft", passed: true, message: "" },
            ]);
        },
        120000,
    );
});

// Builds a gtest against the Sink contract (slot 28, TypeScript backend) and runs it.
async function runSinkGtest(gtestSource: string): Promise<Pick<TestResult, "name" | "passed" | "message">[]> {
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "gtest-sink-"));
    const contractPath = join(dir, "Sink.h");
    writeFileSync(contractPath, SINK);
    const testPath = join(dir, "Sink.test.cpp");
    writeFileSync(testPath, gtestSource);

    const built = await buildCorpusRunner({ corpusPath: testPath, contractPath, contractName: "Sink", stateType: "Sink", slot: 28, corePath: CORE, outDir: dir });
    expect(built.ok, built.stderr).toBe(true);
    const sink = await compileContractWithTypeScript({ source: SINK, contractName: "Sink", slot: 28, qpiHeader: HEADERS(), arenaSizeBytes: 64 * 1024 });
    expect(sink.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const results = await runContractTesting(new Uint8Array(readFileSync(built.wasmPath!)), { 28: sink.wasm });
    return results.map(({ name, passed, message }) => ({ name, passed, message }));
}
