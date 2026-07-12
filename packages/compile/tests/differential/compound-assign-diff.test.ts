import { CORE_PATH } from "../../../../test-utils/paths";
// Compound assignment signedness: >>= must be arithmetic on signed operands, /= and %= must follow the target's signedness,
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
  struct Probe_input { sint64 sa; uint64 ua; };
  struct Probe_output {
    sint64 shrLocal; sint64 shrField;
    uint64 divLocal; uint64 modField;
    uint64 divPlain; uint64 wrapAdd; uint64 shrULocal;
  };
  struct Probe_locals { sint64 sf; uint64 uf; };
  PUBLIC_FUNCTION_WITH_LOCALS(Probe)
  {
    sint64 s = input.sa;
    s >>= 2;
    output.shrLocal = s;

    locals.sf = input.sa;
    locals.sf >>= 2;
    output.shrField = locals.sf;

    uint64 u = input.ua;
    u /= 2;
    output.divLocal = u;

    locals.uf = input.ua;
    locals.uf %= 3;
    output.modField = locals.uf;

    uint64 v = input.ua;
    output.divPlain = v / 3;

    uint32 w = 4294967295u;
    w += 1;
    output.wrapAdd = w;

    uint64 x = input.ua;
    x >>= 1;
    output.shrULocal = x;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Probe, 1); }
};`;

const GTEST = coreGtest("CompoundP", `TEST(CompoundAssign, Signedness) {
  ContractTestingHarness t;
  CONTRACT_STATE_TYPE::Probe_input in{};
  in.sa = -8ll; in.ua = 0x8000000000000001ull;
  auto r = t.call<CONTRACT_STATE_TYPE::Probe_output>(1, in);
  EXPECT_EQ(r.shrLocal, -2ll);                       // arithmetic shift on signed local
  EXPECT_EQ(r.shrField, -2ll);                       // arithmetic shift on signed locals-struct field
  EXPECT_EQ(r.divLocal, 0x4000000000000000ull);      // unsigned /= above 2^63
  EXPECT_EQ(r.modField, 0ull);                       // unsigned %= above 2^63
  EXPECT_EQ(r.divPlain, 3074457345618258603ull);     // unsigned / on a typed local
  EXPECT_EQ(r.wrapAdd, 0ull);                        // uint32 += wraps at 32 bits
  EXPECT_EQ(r.shrULocal, 0x4000000000000000ull);     // logical shift on unsigned
}
`);

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — compound assignment signedness", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("compound ops on locals and fields match native C++ semantics", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "compound-assign-"));
    const contractPath = join(dir, "CompoundP.h");
    writeFileSync(contractPath, SRC);

    const testPath = join(dir, "CompoundP.test.cpp");
    writeFileSync(testPath, GTEST);
    const built = await buildCorpusRunner({
      corpusPath: testPath, contractPath, name: "CompoundP", stateType: "CompoundP", slot: 28,
      corePath: CORE, outDir: dir,
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: SRC, name: "CompoundP", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runContractTesting(runnerWasm, { 28: mine.wasm });
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message.split("\\n")[0]}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
