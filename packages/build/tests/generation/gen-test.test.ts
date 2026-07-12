// gen-test scaffolds the starter `bun:test` spec a new project ships with. The generated source must name
// the contract type consistently (import, declaration, title) or the scaffold won't compile for the user.
import { test, expect } from "bun:test";
import { sampleTest, testRuntimeSource } from "../../src/gen-test";

test("sampleTest: weaves the contract name through import, declaration, and title", () => {
  const src = sampleTest("MyToken");

  expect(src).toContain('import { MyToken, provider } from "./.qinit"');
  expect(src).toContain("let c: MyToken;");
  expect(src).toContain('test("MyToken: starts at zero and increments"');
  expect(src).toContain("beforeAll(() => { c = new MyToken(provider()); });");
});

test("sampleTest: emits a balanced, non-trivial spec", () => {
  const src = sampleTest("Counter");

  expect(src.length).toBeGreaterThan(200);
  expect((src.match(/\{/g) ?? []).length).toBe((src.match(/\}/g) ?? []).length);
  expect(src).toContain('from "bun:test"');
});

test("testRuntimeSource: the inlined SDK template is present and non-empty", () => {
  expect(typeof testRuntimeSource).toBe("string");
  expect(testRuntimeSource.length).toBeGreaterThan(0);
});
