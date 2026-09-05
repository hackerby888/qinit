import { CORE_PATH } from "../../../../test-utils/paths";
// The Wasm runner drives a separately deployed contract in an isolated simulator.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang, buildCorpusRunner, extractIdl, genStdGtest } from "@qinit/build";
import { TEMPLATE_KINDS, templateGtest, templateSource } from "@qinit/build/generate/templates";
import { loadQpiHeader } from "@qinit/compiler";
import { wasiSdkPaths } from "@qinit/core/project";
import { runContractTesting } from "@qinit/engine";
import { runStdGtest, type StdGtestContractSpec } from "../../src/ops/corpus-run";

const CORE = CORE_PATH;
const CONTRACT = `${import.meta.dir}/../../../../fixtures/Counter.h`;
const PROXY = `${import.meta.dir}/../../../../fixtures/Proxy.h`;
const SLOT = 100;
const have = existsSync(`${CORE}/test/contract_testing.h`) && existsSync(CONTRACT) && wasiSdkPaths() !== null;

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
    void setCounter(uint64 value) {
        ((Counter::StateData*)contractStates[Counter_CONTRACT_INDEX])->counter = value;
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
TEST(Counter, StateAtSlot100RoundTrips) {
    ContractTestingCounter t;
    const id user = id::randomValue();
    increaseEnergy(user, 1);
    t.setCounter(40);
    EXPECT_EQ(t.get().value, 40ull);
    t.inc(user);
    EXPECT_EQ(t.get().value, 41ull);
}
TEST(Counter, ReportsFailures) {
    ContractTestingCounter t;
    EXPECT_EQ(t.get().value, 7ull);
}
`;

const PROXY_TEST_SOURCE = `#define NO_UEFI
#include "contract_testing.h"

class ContractTestingProxy : protected ContractTesting {
public:
    ContractTestingProxy() {
        initEmptySpectrum();
        initEmptyUniverse();
        INIT_CONTRACT(Counter);
        INIT_CONTRACT(Proxy);
        callSystemProcedure(Counter_CONTRACT_INDEX, INITIALIZE);
        callSystemProcedure(Proxy_CONTRACT_INDEX, INITIALIZE);
    }
    uint64 readProxy() const {
        Proxy::ReadCounter_input input{};
        Proxy::ReadCounter_output output{};
        callFunction(Proxy_CONTRACT_INDEX, 1, input, output);
        return output.value;
    }
    uint64 readCounter() const {
        Counter::Get_input input{};
        Counter::Get_output output{};
        callFunction(Counter_CONTRACT_INDEX, 1, input, output);
        return output.value;
    }
    void bump(const id& user) {
        Proxy::BumpCounter_input input{};
        Proxy::BumpCounter_output output{};
        invokeUserProcedure(Proxy_CONTRACT_INDEX, 1, input, output, user, 0);
    }
};

TEST(Proxy, CallsCounter) {
    ContractTestingProxy t;
    const id user = id::randomValue();
    increaseEnergy(user, 1000000000);
    EXPECT_EQ(t.readProxy(), 0ull);
    t.bump(user);
    EXPECT_EQ(t.readCounter(), 1ull);
    EXPECT_EQ(t.readProxy(), 1ull);
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
            contractName: "Counter",
            stateType: "Counter",
            slot: SLOT,
            corePath: CORE,
            outDir: `${outDir}/runner`,
            arenaSizeBytes: 64 * 1024 * 1024,
        });
        expect(runner.ok, runner.stderr).toBe(true);

        const contract = await buildContractWithClang({
            contractPath: CONTRACT,
            contractName: "Counter",
            slot: SLOT,
            corePath: CORE,
            outDir: `${outDir}/contract`,
            skipVerify: true,
            arenaSizeBytes: 64 * 1024 * 1024,
        });
        expect(contract.ok, contract.stderr).toBe(true);

        const results = await runContractTesting(new Uint8Array(await Bun.file(runner.wasmPath!).arrayBuffer()), {
            [SLOT]: new Uint8Array(await Bun.file(contract.wasmPath!).arrayBuffer()),
        });
        const by = Object.fromEntries(results.map((result) => [result.name, result]));
        expect(by["Counter.IncrementsTwice"]?.passed).toBe(true);
        expect(by["Counter.FreshStatePerTest"]?.passed).toBe(true);
        expect(by["Counter.StateAtSlot100RoundTrips"]?.passed, by["Counter.StateAtSlot100RoundTrips"]?.message).toBe(true);
        expect(by["Counter.ReportsFailures"]?.passed).toBe(false);
        expect(by["Counter.ReportsFailures"]?.message).toContain("EXPECT_EQ");
    },
    120_000,
);

const dependency: StdGtestContractSpec = {
    contractPath: CONTRACT,
    name: "Counter",
    stateType: "Counter",
    slot: 100,
};

for (const backend of ["clang", "typescript"] as const) {
    test.skipIf(!have)(
        `Proxy GTest calls its Counter dependency with ${backend}`,
        async () => {
            const scratch = mkdtempSync(join(tmpdir(), `qinit-gtest-proxy-${backend}-`));
            const testPath = join(scratch, "Proxy.test.cpp");
            writeFileSync(testPath, PROXY_TEST_SOURCE);

            try {
                const run = await runStdGtest({
                    contractPath: PROXY,
                    testPath,
                    name: "Proxy",
                    stateType: "Proxy",
                    slot: 101,
                    core: CORE,
                    backend,
                    scratch,
                    projectDependencies: [dependency],
                    dynCallees: {
                        Counter: {
                            header: CONTRACT,
                            index: dependency.slot,
                        },
                    },
                });

                expect(run.runnerOk, run.buildError).toBe(true);
                expect(run.results).toHaveLength(1);
                expect(run.results[0]?.name).toBe("Proxy.CallsCounter");
                expect(run.results[0]?.passed, run.results[0]?.message).toBe(true);
            } finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
        180_000,
    );
}

// Every template ships a gtest that has to build and pass on both backends, the way `qinit new` then
// `qinit gtest` runs it; the intercontract one drives its Counter callee at the slot below.
for (const backend of ["clang", "typescript"] as const) {
    for (const kind of TEMPLATE_KINDS) {
        test.skipIf(!have)(
            `${kind} template gtest passes with ${backend}`,
            async () => {
                const scratch = mkdtempSync(join(tmpdir(), `qinit-gtest-${kind}-${backend}-`));
                const name = `Tpl${kind[0].toUpperCase()}${kind.slice(1)}`;
                const contractPath = join(scratch, `${name}.h`);
                const testPath = join(scratch, `${name}.test.cpp`);
                writeFileSync(contractPath, templateSource(kind, name));
                writeFileSync(testPath, templateGtest(kind, name));
                const calleePath = join(scratch, "Counter.h");
                writeFileSync(calleePath, templateSource("counter", "Counter"));
                const callee: StdGtestContractSpec = { contractPath: calleePath, name: "Counter", stateType: "Counter", slot: 100 };

                try {
                    const run = await runStdGtest({
                        contractPath,
                        testPath,
                        name,
                        stateType: name,
                        slot: 101,
                        core: CORE,
                        backend,
                        scratch,
                        ...(kind === "intercontract" ? { projectDependencies: [callee], dynCallees: { Counter: { header: calleePath, index: 100 } } } : {}),
                    });

                    expect(run.runnerOk, run.buildError).toBe(true);
                    expect(run.results.length).toBeGreaterThan(1);
                    for (const result of run.results) {
                        expect(result.passed, `${result.name}: ${result.message}`).toBe(true);
                    }
                } finally {
                    rmSync(scratch, { recursive: true, force: true });
                }
            },
            240_000,
        );
    }
}

// A scaffolded gtest value-initialises every input, which a struct holding a uint128 only allows once
// core's uint128_t has a default constructor.
const WIDE_SOURCE = `using namespace QPI;
struct Wide2 {};
struct Wide : public ContractBase {
    struct StateData { uint128 last; };
    struct Store_input { uint128 v; };
    struct Store_output {};
    struct Peek_input {};
    struct Peek_output { uint128 v; };
    PUBLIC_PROCEDURE(Store) { state.mut().last = input.v; }
    PUBLIC_FUNCTION(Peek) { output.v = state.get().last; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Store, 1); REGISTER_USER_FUNCTION(Peek, 1); }
    INITIALIZE() {}
};
`;

for (const backend of ["clang", "typescript"] as const) {
    test.skipIf(!have)(
        `a scaffolded gtest builds for a contract whose input holds a uint128 with ${backend}`,
        async () => {
            const scratch = mkdtempSync(join(tmpdir(), `qinit-gtest-wide-${backend}-`));
            const contractPath = join(scratch, "Wide.h");
            const testPath = join(scratch, "Wide.test.cpp");
            writeFileSync(contractPath, WIDE_SOURCE);
            writeFileSync(testPath, genStdGtest(extractIdl(WIDE_SOURCE, "Wide", { slot: 101, qpiHeader: loadQpiHeader(CORE) }), "Wide"));

            try {
                const run = await runStdGtest({ contractPath, testPath, name: "Wide", stateType: "Wide", slot: 101, core: CORE, backend, scratch });

                expect(run.runnerOk, run.buildError).toBe(true);
                expect(run.results.length).toBeGreaterThan(0);
            } finally {
                rmSync(scratch, { recursive: true, force: true });
            }
        },
        240_000,
    );
}
