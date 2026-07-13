import { CORE_PATH } from "../../../../test-utils/paths";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

test("only the core-lite ContractTesting source style is public", () => {
  expect(existsSync(resolve(ROOT, "packages/build/src/gen-gtest.ts"))).toBe(false);
  expect(read("packages/cli/src/meta.ts")).not.toMatch(/--lite|--std/);
  expect(read("packages/cli/src/commands/gtest.tsx")).not.toMatch(
    /sniffLite|runTestsAgainst|\bgenGtest\b/,
  );
  expect(read("packages/engine/src/index.ts")).not.toMatch(/\brunTests\b|\brunTestsAgainst\b/);
  expect(read("packages/build/src/assets/wasm_gtest.h")).not.toMatch(/class\s+ContractTest\b/);
});

test("the Qinit-specific lite_test header is no longer required from core-lite", () => {
  const core = CORE_PATH;
  if (existsSync(core)) expect(existsSync(resolve(core, "src/extensions/lite_test.h"))).toBe(false);
});
