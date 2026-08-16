import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Checks END_EPOCH_WITH_LOCALS frame reads and writes against native behavior.
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, expect, beforeAll } from "bun:test";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const EPOCHER = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 acc; uint64 epochs; };
  struct Get_input {}; struct Get_output { uint64 acc; uint64 epochs; };
  struct END_EPOCH_locals { uint64 a; uint64 b; };
  PUBLIC_FUNCTION(Get) { output.acc = state.get().acc; output.epochs = state.get().epochs; }
  END_EPOCH_WITH_LOCALS() {
    locals.a = 7;
    locals.b = locals.a * 6;           // 42 — computed via the locals frame
    state.mut().acc += locals.b;        // accumulates +42 each epoch boundary
    state.mut().epochs += 1;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;

// epochLength is 3000 ticks (QubicSimulator TESTNET_EPOCH_DURATION); each boundary crossing fires END_EPOCH once.
const EPOCHER_GTEST = coreGtest(
    "Epoch",
    `TEST(Epoch, EndEpochUsesLocals) {
  ContractTestingHarness t;
  Epoch::Get_input g{};
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).acc, 0ull);
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).epochs, 0ull);
  t.endEpoch();                            // cross one epoch boundary
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).epochs, 1ull);
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).acc, 42ull);
  t.endEpoch();                            // cross a second boundary
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).epochs, 2ull);
  EXPECT_EQ(t.call<Epoch::Get_output>(1, g).acc, 84ull);
}
`,
);

const wasi = wasiToolchain();

describe("differential gtest — Epoch (END_EPOCH sysproc locals)", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "my Epoch.wasm runs END_EPOCH using its locals frame",
        wasi,
        async () => {
            const runnerWasm = await buildDifferentialRunner({
                corePath: CORE,
                source: EPOCHER,
                testSource: EPOCHER_GTEST,
                name: "Epoch",
                tempPrefix: "epoch-diff-",
            });

            const mine = await compileContractWithTypeScript({
                source: EPOCHER,
                contractName: "Epoch",
                slot: 28,
                qpiHeader: HEADERS,
                arenaSizeBytes: 1024 * 1024,
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
