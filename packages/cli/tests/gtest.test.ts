// End-to-end gtest: compile a contract + its C++ test into ONE wasm (core-lite extensions/lite_test.h), then run
// it on a fresh isolated Virtual Node via @qinit/engine runTests. Proves the combined-module path used by both
// `qinit gtest` and the IDE "Run gtest" button: a passing test, per-test state isolation, and a captured failure.
// Skipped unless a core tree with extensions/lite_test.h (the gtest shim) + the wasi-sdk toolchain are present.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { runTests } from "@qinit/engine";

const CORE = process.env.QINIT_CORE ?? "/home/kali/Projects/core-lite";
const CONTRACT = `${import.meta.dir}/../../../fixtures/Counter.h`;
const have = existsSync(`${CORE}/src/extensions/lite_test.h`) && existsSync(CONTRACT);

const SEED = "a".repeat(55);
const TEST_SOURCE = `
TEST(Counter, IncrementsTwice) {
    ContractTest t;
    Counter::Get_input gin{};
    EXPECT_EQ(t.call<Counter::Get_output>(1, gin).value, 0ull);

    Counter::Inc_input iin{};
    QPI::id user = t.idFromSeed("${SEED}");
    t.invoke<Counter::Inc_output>(1, iin, 0, user);
    t.invoke<Counter::Inc_output>(1, iin, 0, user);
    EXPECT_EQ(t.call<Counter::Get_output>(1, gin).value, 2ull);
}
TEST(Counter, FreshStatePerTest) {
    ContractTest t;   // a new fixture -> the counter is back to 0, not 2 from the previous test
    Counter::Get_input gin{};
    EXPECT_EQ(t.call<Counter::Get_output>(1, gin).value, 0ull);
}
TEST(Counter, ReportsFailures) {
    ContractTest t;
    Counter::Get_input gin{};
    EXPECT_EQ(t.call<Counter::Get_output>(1, gin).value, 7ull);   // wrong on purpose
}
`;

test.skipIf(!have)("a combined contract+gtest wasm runs in the engine (pass, isolation, captured failure)", async () => {
  const r = await buildContract({
    contractPath: CONTRACT, name: "Counter", slot: 1, corePath: CORE,
    outDir: "/tmp/qinit-gtest-test", skipVerify: true, arenaSz: 64 * 1024 * 1024,
    testSource: TEST_SOURCE, testPath: "Counter.test.cpp",
  });
  expect(r.ok, r.stderr).toBe(true);

  const results = await runTests(new Uint8Array(await Bun.file(r.so!).arrayBuffer()));
  const by = Object.fromEntries(results.map((t) => [t.name, t]));

  expect(by["Counter.IncrementsTwice"]?.passed).toBe(true);
  expect(by["Counter.FreshStatePerTest"]?.passed).toBe(true);   // per-test reset (isolation)
  expect(by["Counter.ReportsFailures"]?.passed).toBe(false);
  expect(by["Counter.ReportsFailures"]?.message).toContain("EXPECT_EQ");
}, 120_000);
