import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH } from "../../../../test-utils/paths";
// Checks unary width propagation and mixed signed/unsigned comparisons.
import { coreGtest } from "../support/core-gtest";
import { buildDifferentialRunner } from "../support/differential-runner";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { describe, expect, beforeAll } from "bun:test";
import { runContractTesting, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);

const SRC = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Probe_input { uint64 pad; };
  struct Probe_output {
    uint64 negCmp; uint64 negVal; uint64 notU8; uint64 notU32;
    uint64 mixEq; uint64 mixLt;
  };
  PUBLIC_FUNCTION(Probe)
  {
    uint32 a = 1;
    output.negCmp = (-a < 0) ? 1 : 0;

    uint32 b = 1;
    output.negVal = -b;

    uint8 c = 85;
    output.notU8 = (~c == 0xFFFFFFAA) ? 1 : 0;

    uint32 d = 85;
    output.notU32 = ~d;

    sint32 e = -1;
    uint32 f = 4294967295u;
    output.mixEq = (e == f) ? 1 : 0;

    sint32 g = -2;
    uint32 h = 1u;
    output.mixLt = (g < h) ? 1 : 0;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Probe, 1); }
};`;

const GTEST = coreGtest(
    "UnaryP",
    `TEST(UnaryType, Promotion) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::Probe_input in{};
  auto r = t.call<CONTRACT_STATE_TYPE::Probe_output>(1, in);
  EXPECT_EQ(r.negCmp, 0ull);           // -uint32 is unsigned: 4294967295u < 0 is false
  EXPECT_EQ(r.negVal, 4294967295ull);  // -uint32(1) wraps at 32 bits
  EXPECT_EQ(r.notU8, 1ull);            // ~uint8(85) int-promotes to 0xFFFFFFAA, compares unsigned
  EXPECT_EQ(r.notU32, 4294967210ull);  // ~uint32(85) stays 32-bit
  EXPECT_EQ(r.mixEq, 1ull);            // sint32(-1) converts to 4294967295u
  EXPECT_EQ(r.mixLt, 0ull);            // sint32(-2) converts to 4294967294u, not < 1
}
`,
);

const wasi = wasiToolchain();

describe("differential gtest — unary type propagation", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "unary ops and mixed-width compares match native C++ semantics",
        wasi,
        async () => {
            const runnerWasm = await buildDifferentialRunner({
                corePath: CORE,
                source: SRC,
                testSource: GTEST,
                name: "UnaryP",
                tempPrefix: "unary-type-",
            });

            const mine = await compileContract({
                source: SRC,
                contractName: "UnaryP",
                slot: 28,
                qpiHeader: HEADERS,
                arenaSizeBytes: 1024 * 1024,
            });
            expect(mine.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

            const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
            for (const r of results) {
                console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message.split("\\n")[0]}`);
            }
            expect(results.length).toBeGreaterThan(0);
            expect(results.every((r) => r.passed)).toBe(true);
        },
        120000,
    );
});
