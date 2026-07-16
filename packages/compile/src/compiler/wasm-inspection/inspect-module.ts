import { LHOST_ABI } from "@qinit/core";
import type { WasmModuleInspection, WasmModuleInspectionOptions } from "./inspection-types";
import { PORTABLE_FEATURES } from "./inspection-types";
import { emptyParsed } from "./parsed-module";
import { parseModule } from "./module-parser";
import { WasmParseError, error } from "./binary-reader";
import { classifyMemory, validateExports, validateImports } from "./module-validation";

export function asUint8Array(bytes: Uint8Array | ArrayBuffer): Uint8Array {
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

// Inspect a module against the production Wasm module ABI and JS+WAMR portability profile.
// No imports are invoked and the module is never instantiated.
export function inspectWasmModule(input: Uint8Array | ArrayBuffer, options: WasmModuleInspectionOptions = {}): WasmModuleInspection {
    const bytes = asUint8Array(input);
    const parsed = emptyParsed();
    try {
        parseModule(bytes, parsed);
    }
    catch (caught) {
        const offset = caught instanceof WasmParseError ? caught.offset : undefined;
        const message = caught instanceof Error ? caught.message : String(caught);
        error(parsed.diagnostics, "malformed-module", message, offset);
        for (const feature of [...parsed.features].sort()) {
            if (PORTABLE_FEATURES.has(feature))
                continue;
            error(parsed.diagnostics, "unsupported-feature", `unsupported Wasm feature: ${feature}`);
        }
        return {
            ok: false,
            diagnostics: parsed.diagnostics,
            imports: parsed.imports,
            exports: parsed.exports,
            memories: parsed.memories,
            memoryMode: classifyMemory(parsed.memories),
            features: [...parsed.features].sort(),
        };
    }
    // JS validation catches index/type/control-flow errors outside this structural parser.
    try {
        if (typeof WebAssembly !== "undefined" &&
            !WebAssembly.validate(bytes as unknown as BufferSource)) {
            error(parsed.diagnostics, "js-validation", "JavaScript WebAssembly.validate rejected the module");
        }
    }
    catch (caught) {
        error(parsed.diagnostics, "js-validation", `JavaScript Wasm validation failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    validateImports(parsed, options.lhostAbi ?? LHOST_ABI);
    const memoryMode = classifyMemory(parsed.memories);
    if (parsed.memories.length !== 1) {
        error(parsed.diagnostics, "memory-count", `expected exactly one wasm32 memory; found ${parsed.memories.length}`);
    }
    const expectedMode = options.memoryMode ?? "defined";
    if (expectedMode !== "either" && memoryMode !== expectedMode) {
        error(parsed.diagnostics, "memory-mode", `expected ${expectedMode} memory; module uses ${memoryMode} memory`);
    }
    validateExports(parsed, memoryMode);
    for (const feature of [...parsed.features].sort()) {
        if (PORTABLE_FEATURES.has(feature))
            continue;
        error(parsed.diagnostics, "unsupported-feature", `unsupported Wasm feature: ${feature}`);
    }
    return {
        ok: parsed.diagnostics.length === 0,
        diagnostics: parsed.diagnostics,
        imports: parsed.imports,
        exports: parsed.exports,
        memories: parsed.memories,
        memoryMode,
        features: [...parsed.features].sort(),
    };
}
