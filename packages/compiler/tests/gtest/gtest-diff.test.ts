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

// Scout's private Inspect is what a QTF-style test calls straight from the runner, so its qpi calls go through the runner's host.
const SCOUT = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 unused; };
  struct Clock_input {};
  struct Clock_output { uint16 epoch; uint32 tick; uint32 initialTick; uint8 year; uint8 month; uint8 day; uint8 hour; uint8 minute; uint8 second; uint16 millisecond; };
  struct Twice_input { uint64 value; }; struct Twice_output { uint64 value; };
  struct Inspect_input { id issuer; uint64 name; id owner; };
  struct Inspect_output { sint64 possessed; sint64 total; uint64 holders; uint8 weekday; id computor0; uint16 epoch; uint32 tick; uint32 initialTick; uint64 twice; };
  struct Inspect_locals { Asset asset; AssetPossessionIterator iter; Twice_input twiceIn; Twice_output twiceOut; };
  struct IssueFor_input { uint64 name; }; struct IssueFor_output { sint64 issued; };
  PUBLIC_FUNCTION(Clock) {
    output.epoch = qpi.epoch();
    output.tick = qpi.tick();
    output.initialTick = qpi.initialTick();
    output.year = qpi.year();
    output.month = qpi.month();
    output.day = qpi.day();
    output.hour = qpi.hour();
    output.minute = qpi.minute();
    output.second = qpi.second();
    output.millisecond = qpi.millisecond();
  }
  PRIVATE_FUNCTION(Twice) { output.value = input.value * 2; }
  PRIVATE_FUNCTION_WITH_LOCALS(Inspect) {
    output.possessed = qpi.numberOfPossessedShares(input.name, input.issuer, input.owner, input.owner, SELF_INDEX, SELF_INDEX);
    locals.asset.issuer = input.issuer;
    locals.asset.assetName = input.name;
    locals.iter.begin(locals.asset);
    while (!locals.iter.reachedEnd()) {
      output.holders += 1;
      output.total += locals.iter.numberOfPossessedShares();
      locals.iter.next();
    }
    output.weekday = qpi.dayOfWeek(24, 1, 1);
    output.computor0 = qpi.computor(0);
    output.epoch = qpi.epoch();
    output.tick = qpi.tick();
    output.initialTick = qpi.initialTick();
    locals.twiceIn.value = 21;
    CALL(Twice, locals.twiceIn, locals.twiceOut);
    output.twice = locals.twiceOut.value;
  }
  PRIVATE_PROCEDURE(IssueFor) { output.issued = qpi.issueAsset(input.name, qpi.invocator(), 0, 1000, 0); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Clock, 1); }
};
`;

const SCOUT_GTEST = `#define NO_UEFI
#include "contract_testing.h"
class ScoutChecker : public Scout, public Scout::StateData {
public:
  const QPI::ContractState<StateData, Scout_CONTRACT_INDEX>& asState() const {
    return *reinterpret_cast<const QPI::ContractState<StateData, Scout_CONTRACT_INDEX>*>(static_cast<const StateData*>(this));
  }
  Inspect_output inspect(const QPI::QpiContextFunctionCall& qpi, const id& issuer, uint64 name, const id& owner) const {
    Inspect_input input{ issuer, name, owner };
    Inspect_output output{};
    // the iterator's constructor is protected, so the locals are zeroed bytes, as core's own stack hands them out
    alignas(Inspect_locals) unsigned char localsBuffer[sizeof(Inspect_locals)] = {};
    Inspect(qpi, asState(), input, output, *reinterpret_cast<Inspect_locals*>(localsBuffer));
    return output;
  }
  IssueFor_output issueFor(const QPI::QpiContextProcedureCall& qpi, uint64 name) {
    IssueFor_input input{ name };
    IssueFor_output output{};
    IssueFor_locals locals{};
    IssueFor(qpi, *reinterpret_cast<QPI::ContractState<StateData, Scout_CONTRACT_INDEX>*>(static_cast<StateData*>(this)), input, output, locals);
    return output;
  }
};
class ContractTestingScout : protected ContractTesting {
public:
  ContractTestingScout() {
    initEmptySpectrum();
    initEmptyUniverse();
    INIT_CONTRACT(Scout);
  }
  ScoutChecker* state() { return reinterpret_cast<ScoutChecker*>(contractStates[Scout_CONTRACT_INDEX]); }
  Scout::Clock_output clock() const {
    Scout::Clock_output output{};
    callFunction(Scout_CONTRACT_INDEX, 1, Scout::Clock_input(), output);
    return output;
  }
};
TEST(Scout, PrivateFunctionSeesTheEngine) {
  ContractTestingScout t;
  const id issuer = id::randomValue();
  const id holder = id::randomValue();
  increaseEnergy(issuer, 1000000000);
  int issuance, ownership, possession, holderOwnership, holderPossession;
  EXPECT_EQ(issueAsset(issuer, "SCOUT", 0, CONTRACT_ASSET_UNIT_OF_MEASUREMENT, 1000, Scout_CONTRACT_INDEX, &issuance, &ownership, &possession), 1000ll);
  EXPECT_TRUE(transferShareOwnershipAndPossession(ownership, possession, holder, 300, &holderOwnership, &holderPossession, true));
  broadcastedComputors.computors.publicKeys[0] = holder;
  system.epoch = 7;
  system.tick = 1234;
  system.initialTick = 1200;
  QpiContextUserFunctionCall qpi(Scout_CONTRACT_INDEX);
  const Scout::Inspect_output output = t.state()->inspect(qpi, issuer, assetNameFromString("SCOUT"), holder);
  EXPECT_EQ(output.possessed, 300ll);
  EXPECT_EQ(output.total, 1000ll);
  EXPECT_EQ(output.holders, 2ull);
  EXPECT_EQ(output.weekday, 5);
  EXPECT_EQ(output.computor0, holder);
  EXPECT_EQ(output.epoch, 7);
  EXPECT_EQ(output.tick, 1234u);
  EXPECT_EQ(output.initialTick, 1200u);
  EXPECT_EQ(output.twice, 42ull);
}
TEST(Scout, PrivateProcedureActsForItsContextsInvocator) {
  ContractTestingScout t;
  const id user = id::randomValue();
  increaseEnergy(user, 1000000000);
  const uint64 name = assetNameFromString("SCOUTB");
  QpiContextUserProcedureCall qpi(Scout_CONTRACT_INDEX, user, 0);
  EXPECT_EQ(t.state()->issueFor(qpi, name).issued, 1000ll);
  EXPECT_EQ(numberOfPossessedShares(name, user, user, user, Scout_CONTRACT_INDEX, Scout_CONTRACT_INDEX), 1000ll);
}
TEST(Scout, SystemIsAPlainGlobal) {
  ContractTestingScout t;
  system.epoch = 10;
  system.tick = 100;
  const auto startTick = system.tick;
  ++system.tick;
  --system.epoch;
  EXPECT_EQ(startTick + 1, system.tick);
  EXPECT_EQ(system.epoch, 9);
  EXPECT_EQ(div(system.tick, 2u), 50u);
  EXPECT_EQ(mod(system.epoch, (uint16)4), 1);
  QpiContextUserFunctionCall qpi(Scout_CONTRACT_INDEX);
  EXPECT_EQ(qpi.tick(), 101u);
  EXPECT_EQ(qpi.epoch(), 9);
  EXPECT_EQ(t.clock().tick, 101u);
  EXPECT_EQ(t.clock().epoch, 9);
}
TEST(Scout, SystemOutlivesTheFixture) {
  system.epoch = 33;
  { ContractTestingScout first; }
  ContractTestingScout second;
  EXPECT_EQ(second.clock().epoch, 33);
}
TEST(Scout, EtalonTickIsTheContractsClock) {
  ContractTestingScout t;
  etalonTick.year = 25;
  etalonTick.month = 3;
  etalonTick.day = 4;
  etalonTick.hour = 5;
  etalonTick.minute = 6;
  etalonTick.second = 7;
  etalonTick.millisecond = 890;
  const auto hour = etalonTick.hour;
  etalonTick.hour += 1;
  EXPECT_EQ(hour, 5);
  const QPI::DateAndTime now = QPI::DateAndTime::now();
  EXPECT_EQ(now.getYear(), 2025);
  EXPECT_EQ(now.getHour(), 6);
  EXPECT_EQ(now.getMillisec(), 890);
  const Scout::Clock_output clock = t.clock();
  EXPECT_EQ(clock.year, 25);
  EXPECT_EQ(clock.month, 3);
  EXPECT_EQ(clock.day, 4);
  EXPECT_EQ(clock.hour, 6);
  EXPECT_EQ(clock.minute, 6);
  EXPECT_EQ(clock.second, 7);
  EXPECT_EQ(clock.millisecond, 890);
  const unsigned int tick = system.tick;
  advanceTimeAndTick(1500);
  EXPECT_EQ(system.tick, tick + 1);
  EXPECT_EQ(t.clock().second, 9);
  EXPECT_EQ(t.clock().millisecond, 390);
}
TEST(Scout, UpdateTimeReadsTheWallClock) {
  ContractTestingScout t;
  updateTime();
  EXPECT_GE(utcTime.Year, 2025);
  updateQpiTime();
  EXPECT_EQ(t.clock().year, utcTime.Year - 2000);
  EXPECT_EQ(t.clock().month, utcTime.Month);
}
TEST(Scout, PassingMacrosStream) {
  SUCCEED() << "fine";
  EXPECT_NEAR(1.0, 1.05, 0.1) << "close enough";
  ASSERT_NEAR(10, 12, 2) << "integers too";
}
TEST(Scout, SkipReturnsEarly) {
  GTEST_SKIP() << "not today";
  FAIL() << "unreachable";
}
TEST(Scout, FailureMacrosReport) {
  ADD_FAILURE() << "first";
  EXPECT_TRUE(true);
  FAIL() << "second";
  ADD_FAILURE() << "unreachable";
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
            const results = await runSlot28Gtest(SINK_GTEST);
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
            const results = await runSlot28Gtest(SINK_HELPERS_GTEST);
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

    // a private function the test calls directly runs in the runner: its qpi, the system/etalonTick globals and gtest's macros must act as core's.
    toolchainTest(
        "runner-run contract code, core's clock globals and gtest's macros behave as in core",
        wasi,
        async () => {
            const results = await runSlot28Gtest(SCOUT_GTEST, "Scout", SCOUT);
            const failures = results.filter((result) => result.name !== "Scout.FailureMacrosReport");
            expect(failures).toEqual([
                { name: "Scout.PrivateFunctionSeesTheEngine", passed: true, message: "" },
                { name: "Scout.PrivateProcedureActsForItsContextsInvocator", passed: true, message: "" },
                { name: "Scout.SystemIsAPlainGlobal", passed: true, message: "" },
                { name: "Scout.SystemOutlivesTheFixture", passed: true, message: "" },
                { name: "Scout.EtalonTickIsTheContractsClock", passed: true, message: "" },
                { name: "Scout.UpdateTimeReadsTheWallClock", passed: true, message: "" },
                { name: "Scout.PassingMacrosStream", passed: true, message: "" },
                { name: "Scout.SkipReturnsEarly", passed: true, message: "" },
            ]);
            const reported = results.find((result) => result.name === "Scout.FailureMacrosReport");
            expect(reported?.passed).toBe(false);
            expect(reported?.message).toContain("ADD_FAILURE()");
            expect(reported?.message).toContain("first");
            expect(reported?.message).toContain("FAIL()");
            expect(reported?.message).toContain("second");
            expect(reported?.message).not.toContain("unreachable");
        },
        120000,
    );
});

// Builds a gtest against a contract at slot 28 (TypeScript backend) and runs it.
async function runSlot28Gtest(gtestSource: string, name = "Sink", source = SINK): Promise<Pick<TestResult, "name" | "passed" | "message">[]> {
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), `gtest-${name.toLowerCase()}-`));
    const contractPath = join(dir, `${name}.h`);
    writeFileSync(contractPath, source);
    const testPath = join(dir, `${name}.test.cpp`);
    writeFileSync(testPath, gtestSource);

    const built = await buildCorpusRunner({ corpusPath: testPath, contractPath, contractName: name, stateType: name, slot: 28, corePath: CORE, outDir: dir });
    expect(built.ok, built.stderr).toBe(true);
    const contract = await compileContractWithTypeScript({ source, contractName: name, slot: 28, qpiHeader: HEADERS(), arenaSizeBytes: 64 * 1024 });
    expect(contract.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const results = await runContractTesting(new Uint8Array(readFileSync(built.wasmPath!)), { 28: contract.wasm });
    return results.map(({ name, passed, message }) => ({ name, passed, message }));
}
