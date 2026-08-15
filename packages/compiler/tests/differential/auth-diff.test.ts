import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Covers invocator capture, id equality guards, and id-valued state reads.
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, expect, beforeAll } from "bun:test";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const AUTH = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { id last; uint64 count; };
  struct Remember_input {}; struct Remember_output {};
  struct IsLast_input { id who; }; struct IsLast_output { uint64 yes; };
  struct LastId_input {}; struct LastId_output { id who; };
  struct Count_input {}; struct Count_output { uint64 n; };
  PUBLIC_PROCEDURE(Remember) {
    state.mut().last = qpi.invocator();
    state.mut().count++;
  }
  PUBLIC_FUNCTION(IsLast) {
    output.yes = (state.get().last == input.who) ? 1 : 0;
  }
  PUBLIC_FUNCTION(LastId) {
    output.who = state.get().last;
  }
  PUBLIC_FUNCTION(Count) {
    output.n = state.get().count;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Remember, 1);
    REGISTER_USER_FUNCTION(IsLast, 1);
    REGISTER_USER_FUNCTION(LastId, 2);
    REGISTER_USER_FUNCTION(Count, 3);
  }
};
`;

const AUTH_GTEST = coreGtest(
    "Auth",
    `TEST(Auth, InvocatorCapturedAndCompared) {
  ContractTestingHarness t;
  QPI::id u = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  QPI::id other = t.idFromSeed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  t.fund(u, 1000000000ll);
  Auth::Remember_input r{};
  t.invoke<Auth::Remember_output>(1, r, 0, u);
  Auth::IsLast_input q{}; q.who = u;
  EXPECT_EQ(t.call<Auth::IsLast_output>(1, q).yes, 1ull);
  q.who = other;
  EXPECT_EQ(t.call<Auth::IsLast_output>(1, q).yes, 0ull);
  Auth::LastId_input li{};
  EXPECT_TRUE(t.call<Auth::LastId_output>(2, li).who == u);
  Auth::Count_input ci{};
  EXPECT_EQ(t.call<Auth::Count_output>(3, ci).n, 1ull);
}
`,
);

const wasi = wasiToolchain();

describe("differential gtest — Auth (qpi.invocator + id compare)", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "my Auth.wasm passes the native Auth gtest",
        wasi,
        async () => {
            const runnerWasm = await buildDifferentialRunner({
                corePath: CORE,
                source: AUTH,
                testSource: AUTH_GTEST,
                name: "Auth",
                tempPrefix: "auth-diff-",
            });

            const mine = await compileContract({
                source: AUTH,
                contractName: "Auth",
                slot: 28,
                qpiHeader: HEADERS,
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
