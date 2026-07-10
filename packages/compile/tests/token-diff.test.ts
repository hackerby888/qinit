// Differential gtest for Token.h — exercises qpi host calls (issueAsset / isAssetIssued / nextId) and id construction (SELF)
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { runTestsAgainst, type TestResult } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);
const TOKEN = readFileSync("/home/kali/Projects/Qinit/fixtures/Token.h", "utf8");

// Issue = procedure it=1, Issued = func it=2, NextId = func it=4, Last = func it=5.
const TOKEN_GTEST = `TEST(Token, IssueResultFlowsToStateAndOutput) {
  ContractTest t;
  QPI::id u = t.idFromSeed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  t.fund(u, 1000000000000ll);
  Token::Issue_input ii{}; ii.name = 5460308ull; ii.shares = 1000ll;
  auto ir = t.invoke<Token::Issue_output>(1, ii, 0, u);
  Token::Last_input li{};
  EXPECT_EQ(t.call<Token::Last_output>(5, li).result, ir.result);
}
TEST(Token, IssuedReadsAssetUniverse) {
  ContractTest t;
  Token::Issued_input qi{}; qi.name = 5460308ull;
  EXPECT_EQ(t.call<Token::Issued_output>(2, qi).issued, 0ll);
}
TEST(Token, NextIdIsDeterministic) {
  ContractTest t;
  QPI::id u = t.idFromSeed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  Token::NextId_input ni{}; ni.cur = u;
  auto a = t.call<Token::NextId_output>(4, ni);
  auto b = t.call<Token::NextId_output>(4, ni);
  EXPECT_TRUE(a.next == b.next);
  EXPECT_FALSE(a.next == u);
}
`;

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

describe("differential gtest — Token (qpi host calls)", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("my Token.wasm passes the native Token gtest", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "token-diff-"));
    const contractPath = join(dir, "Token.h");
    writeFileSync(contractPath, TOKEN);

    const built = await buildContract({
      contractPath, name: "Token", slot: 28, corePath: CORE, outDir: dir,
      skipVerify: true, testSource: TOKEN_GTEST, testPath: "Token.test.cpp",
    });
    expect(built.ok).toBe(true);
    const runnerWasm = new Uint8Array(readFileSync(built.so!));

    const mine = await compileContract({ source: TOKEN, name: "Token", slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    // numberOfShares (Select args) is a known gap — only errors should block; warnings are fine.
    expect(mine.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const results: TestResult[] = await runTestsAgainst(runnerWasm, mine.wasm);
    for (const r of results) {
      console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}${r.passed ? "" : " — " + r.message}`);
    }
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  }, 120000);
});
