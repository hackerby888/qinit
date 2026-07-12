import { describe, expect, test } from "bun:test";
import { emitModule, type ModuleSpec } from "../../src/framework";
import {
  inspectLiteWasmModule,
  LHOST_ABI,
  LITE_WASM_FUNCTION_ABI,
} from "../../src/compiler/wasm-inspect";

const SPEC: ModuleSpec = {
  stateSize: 8,
  arenaSize: 64 * 1024,
  entries: [],
  sysprocs: [],
  userFunctionsWat: "  ;; no user functions",
};

const FEATURES = {
  bulk_memory: true,
  multi_value: true,
  sign_extension: true,
  simd: true,
} as const;

async function assemble(wat: string): Promise<Uint8Array> {
  const wabt = await import("wabt");
  const api = await wabt.default();
  const module = api.parseWat("wasm-inspect.test.wat", wat, FEATURES);
  try {
    module.validate();
    return new Uint8Array(module.toBinary({}).buffer);
  } finally {
    module.destroy();
  }
}

function addToModule(wat: string, field: string): string {
  return wat.replace("(module", `(module\n${field}`);
}

function addDefinition(wat: string, field: string): string {
  return wat.replace('  (memory (export "memory")', `${field}\n  (memory (export "memory")`);
}

function codes(result: ReturnType<typeof inspectLiteWasmModule>): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("Lite Wasm module inspection", () => {
  test("accepts and describes the production generated ABI", async () => {
    const result = inspectLiteWasmModule(await assemble(emitModule(SPEC)));

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.memoryMode).toBe("defined");
    expect(result.memories).toEqual([{
      source: "defined",
      minimumPages: 6n,
      maximumPages: 6n,
      shared: false,
      memory64: false,
    }]);
    expect(result.features).toEqual([]);

    const lhostImports = result.imports.filter((imported) => imported.module === "lhost");
    expect(lhostImports).toHaveLength(Object.keys(LHOST_ABI).length);
    expect(lhostImports.find((imported) => imported.name === "acquireScratch")?.signature)
      .toEqual({ params: ["i64", "i32"], results: ["i32"] });
    expect(result.exports.find((exported) => exported.name === "dispatch")?.signature)
      .toEqual(LITE_WASM_FUNCTION_ABI.dispatch);
  });

  test("accepts the established imported-memory mode only when requested", async () => {
    const wasm = await assemble(emitModule({ ...SPEC, memBase: 64 * 1024 }));
    const shared = inspectLiteWasmModule(wasm, { memoryMode: "imported" });

    expect(shared.ok).toBe(true);
    expect(shared.memoryMode).toBe("imported");
    expect(shared.memories[0]).toMatchObject({
      source: "imported",
      module: "env",
      name: "memory",
      shared: false,
      memory64: false,
    });
    expect(shared.exports.some((exported) => exported.name === "memory")).toBe(false);

    const production = inspectLiteWasmModule(wasm);
    expect(production.ok).toBe(false);
    expect(codes(production)).toContain("memory-mode");
  });

  test("rejects unknown modules and lhost signature drift", async () => {
    const wat = addToModule(emitModule(SPEC), `
  (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32)))
  (import "lhost" "notInCoreTable" (func))
  (import "lhost" "epoch" (func (param i64)))`);
    const result = inspectLiteWasmModule(await assemble(wat));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "unknown-import" && diagnostic.message.includes("wasi_snapshot_preview1.fd_write"))).toBe(true);
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "unknown-import" && diagnostic.message.includes("notInCoreTable"))).toBe(true);
    expect(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "import-signature" && diagnostic.message.includes("lhost.epoch"))).toBe(true);
  });

  test("rejects missing and incorrectly typed ABI exports", async () => {
    const missingDispatch = emitModule(SPEC).replace('  (export "dispatch" (func $dispatch))\n', "");
    const missing = inspectLiteWasmModule(await assemble(missingDispatch));
    expect(missing.diagnostics.some((diagnostic) =>
      diagnostic.code === "missing-export" && diagnostic.message.includes("dispatch"))).toBe(true);

    const wrongStateAddr = emitModule(SPEC).replace(
      "  (func $state_addr (result i32) (i32.const 0))",
      "  (func $state_addr (result i64) (i64.const 0))",
    );
    const wrong = inspectLiteWasmModule(await assemble(wrongStateAddr));
    expect(wrong.diagnostics.some((diagnostic) =>
      diagnostic.code === "export-signature" && diagnostic.message.includes("state_addr"))).toBe(true);
  });

  const unsupported = [
    ["bulk memory", `  (func $unsupported
    (i32.const 0) (i32.const 0) (i32.const 0) memory.fill)`],
    ["SIMD", `  (func $unsupported
    (drop (i8x16.splat (i32.const 0))))`],
    ["multi-value results", `  (func $unsupported (result i32 i32)
    (i32.const 1) (i32.const 2))`],
  ] as const;

  for (const [label, field] of unsupported) {
    test(`rejects ${label}`, async () => {
      const result = inspectLiteWasmModule(await assemble(addDefinition(emitModule(SPEC), field)));

      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("unsupported-feature");
      expect(result.features.length).toBeGreaterThan(0);
    });
  }

  test("accepts sign-extension operators supported by release WAMR", async () => {
    const field = `  (func $portable (drop (i32.extend8_s (i32.const 255))))`;
    const result = inspectLiteWasmModule(await assemble(addDefinition(emitModule(SPEC), field)));
    expect(result.ok).toBe(true);
    expect(result.features).toContain("sign-extension-operators");
  });

  test("fails closed on malformed binaries", () => {
    const result = inspectLiteWasmModule(new Uint8Array([0, 97, 115, 109]));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("malformed-module");
  });
});
