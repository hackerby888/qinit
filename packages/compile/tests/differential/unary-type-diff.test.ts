import { CORE_PATH } from "../../../../test-utils/paths";
// Unary operator type propagation: -x and ~x carry their operand's promoted type into comparisons and stores (unsigned 32-bit
import { coreGtest } from "../support/core-gtest";
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { buildCorpusRunner } from "@qinit/build";
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

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — unary type propagation", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("unary ops and mixed-width compares match native C++ semantics", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "unary-type-"));
    const contractPath = join(dir, "UnaryP.h");
    writeFileSync(contractPath, SRC);

    const testPath = join(dir, "UnaryP.test.cpp");
    writeFileSync(testPath, GTEST);
    const built = await buildCorpusRunner({
      corpusPath: testPath,
      contractPath,
      name: "UnaryP",
      stateType: "UnaryP",
      slot: 28,
      corePath: CORE,
      outDir: dir,
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({
      source: SRC,
      name: "UnaryP",
      slot: 28,
      qpiHeader: HEADERS,
      arenaSz: 1024 * 1024,
    });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
    for (const r of results) {
      console.log(
        `  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message.split("\\n")[0]}`,
      );
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
