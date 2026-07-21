import { describe, expect, test } from "bun:test";
import { emitModule, type ModuleSpecification } from "../../src/framework";
import {
  inspectWasmModule,
  LHOST_ABI,
  WASM_MODULE_EXPORT_ABI,
} from "../../src/compiler/wasm-inspect";
import { QPI_CONTEXT_LAYOUT } from "../support/qpi-context-layout";

const SPEC: ModuleSpecification = {
  contractSlot: 29,
  stateSize: 8,
  arenaSize: 64 * 1024,
  contextLayout: QPI_CONTEXT_LAYOUT,
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

function codes(result: ReturnType<typeof inspectWasmModule>): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

describe("Wasm module inspection", () => {
  test("accepts and describes the production generated ABI", async () => {
    const wat = emitModule(SPEC);
    const result = inspectWasmModule(await assemble(wat));

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.memoryMode).toBe("defined");
    expect(result.memories).toEqual([
      {
        source: "defined",
        minimumPages: 6n,
        maximumPages: 6n,
        shared: false,
        memory64: false,
      },
    ]);
    expect(result.features).toEqual([]);
    expect(wat).not.toContain("arena_top");
    expect(wat).toContain(
      "(call $lh_acquireScratch (i64.extend_i32_u (local.get $size)) (i32.const 1))",
    );
    expect(wat).toContain("(call $lh_releaseScratch (local.get $ptr))");

    const lhostImports = result.imports.filter((imported) => imported.module === "lhost");
    expect(lhostImports).toHaveLength(Object.keys(LHOST_ABI).length);
    expect(lhostImports.find((imported) => imported.name === "acquireScratch")?.signature).toEqual({
      params: ["i64", "i32"],
      results: ["i32"],
    });
    expect(result.exports.find((exported) => exported.name === "dispatch")?.signature).toEqual(
      WASM_MODULE_EXPORT_ABI.dispatch,
    );
    expect(
      result.exports.find((exported) => exported.name === "contract_index")?.signature,
    ).toEqual(WASM_MODULE_EXPORT_ABI.contract_index);

    const module = new WebAssembly.Module((await assemble(emitModule(SPEC))) as BufferSource);
    const lhost = Object.fromEntries(
      Object.entries(LHOST_ABI).map(([name, signature]) => [
        name,
        () => (signature.results[0] === "i64" ? 0n : 0),
      ]),
    );
    const instance = new WebAssembly.Instance(module, { lhost });
    expect((instance.exports.contract_index as () => number)()).toBe(29);
  });

  test("rejects the legacy arena_top export", async () => {
    const wat = addDefinition(
      emitModule(SPEC),
      '  (global (export "arena_top") (mut i32) (i32.const 0))',
    );
    const result = inspectWasmModule(await assemble(wat));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("legacy-export");
  });

  test("accepts the established imported-memory mode only when requested", async () => {
    const wasm = await assemble(emitModule({ ...SPEC, memBase: 64 * 1024 }));
    const shared = inspectWasmModule(wasm, { memoryMode: "imported" });

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

    const production = inspectWasmModule(wasm);
    expect(production.ok).toBe(false);
    expect(codes(production)).toContain("memory-mode");
  });

  test("rejects unknown modules and lhost signature drift", async () => {
    const wat = addToModule(
      emitModule(SPEC),
      `
  (import "wasi_snapshot_preview1" "fd_write" (func (param i32 i32 i32 i32) (result i32)))
  (import "lhost" "notInCoreTable" (func))
  (import "lhost" "epoch" (func (param i64)))`,
    );
    const result = inspectWasmModule(await assemble(wat));

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unknown-import" &&
          diagnostic.message.includes("wasi_snapshot_preview1.fd_write"),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unknown-import" && diagnostic.message.includes("notInCoreTable"),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "import-signature" && diagnostic.message.includes("lhost.epoch"),
      ),
    ).toBe(true);
  });

  test("rejects missing and incorrectly typed ABI exports", async () => {
    const wrongContractIndex = emitModule(SPEC).replace(
      "  (func $contract_index (result i32) (i32.const 29))",
      "  (func $contract_index (param i32) (result i32) (local.get 0))",
    );
    const wrongContract = inspectWasmModule(await assemble(wrongContractIndex));
    expect(
      wrongContract.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "export-signature" &&
          diagnostic.message.includes("contract_index"),
      ),
    ).toBe(true);

    const missingDispatch = emitModule(SPEC).replace(
      '  (export "dispatch" (func $dispatch))\n',
      "",
    );
    const missing = inspectWasmModule(await assemble(missingDispatch));
    expect(
      missing.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "missing-export" && diagnostic.message.includes("dispatch"),
      ),
    ).toBe(true);

    const wrongStateAddr = emitModule(SPEC).replace(
      "  (func $state_addr (result i32) (i32.const 0))",
      "  (func $state_addr (result i64) (i64.const 0))",
    );
    const wrong = inspectWasmModule(await assemble(wrongStateAddr));
    expect(
      wrong.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "export-signature" && diagnostic.message.includes("state_addr"),
      ),
    ).toBe(true);
  });

  const unsupported = [
    [
      "SIMD",
      `  (func $unsupported
    (drop (i8x16.splat (i32.const 0))))`,
    ],
    [
      "multi-value results",
      `  (func $unsupported (result i32 i32)
    (i32.const 1) (i32.const 2))`,
    ],
  ] as const;

  for (const [label, field] of unsupported) {
    test(`rejects ${label}`, async () => {
      const result = inspectWasmModule(await assemble(addDefinition(emitModule(SPEC), field)));

      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("unsupported-feature");
      expect(result.features.length).toBeGreaterThan(0);
    });
  }

  test("accepts sign-extension operators supported by release WAMR", async () => {
    const field = `  (func $portable (drop (i32.extend8_s (i32.const 255))))`;
    const result = inspectWasmModule(await assemble(addDefinition(emitModule(SPEC), field)));
    expect(result.ok).toBe(true);
    expect(result.features).toContain("sign-extension-operators");
  });

  test("accepts bulk-memory operations supported by release WAMR", async () => {
    const field = `  (func $portable
    (i32.const 0) (i32.const 0) (i32.const 0) memory.fill)`;
    const result = inspectWasmModule(await assemble(addDefinition(emitModule(SPEC), field)));
    expect(result.ok).toBe(true);
    expect(result.features).toContain("bulk-memory");
  });

  test("fails closed on malformed binaries", () => {
    const result = inspectWasmModule(new Uint8Array([0, 97, 115, 109]));

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("malformed-module");
  });
});
