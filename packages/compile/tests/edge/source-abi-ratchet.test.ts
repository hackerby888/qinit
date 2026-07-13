import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readSourceTree } from "../support/source-tree";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("removed QPI and Wasm ABI mirrors cannot return", () => {
  const qpi = readSourceTree("../../src/backend/wasm/calls", import.meta.url);
  const framework = readSourceTree("../../src/backend/wasm/framework", import.meta.url);
  const recipe = source("../../../build/src/recipe.ts");
  const runtime = source("../../../engine/src/runtime.ts");
  const codegen = source("../../src/codegen/index.ts");
  const testing = source("../../../build/src/assets/wasm_contract_testing.h");
  const tables = readSourceTree("../../src/backend/wasm/abi", import.meta.url);

  expect(qpi).not.toContain("RAW_QPI_BINDINGS");
  expect(qpi).not.toContain("QPI_BINDINGS");
  expect(qpi).not.toContain("QPI_AGGREGATE_LAYOUTS");
  expect(framework).not.toContain("emitQpiBindingForwarders");
  expect(recipe).not.toContain("WASM_QPI_SHIM");
  expect(recipe).not.toContain("__qinitAssetEntry");
  expect(runtime).not.toMatch(/INITIALIZE:\s*0/);
  expect(testing).not.toMatch(/INITIALIZE\s*=\s*0/);
  expect(tables).not.toContain("SYSPROC_IMPL");
  expect(tables).not.toContain("__impl_initialize");
  expect(codegen).not.toContain("known formulas");
  expect(codegen).not.toContain("size approximate");
});
