import type { InspectedMemoryMode, InspectedWasmExport, InspectedWasmMemory, WasmFunctionSignature } from "./inspection-types";
import { WASM_MODULE_EXPORT_ABI, signature } from "./inspection-types";
import type { ParsedModule } from "./parsed-module";
import { error } from "./binary-reader";

export function sameSignature(argument: WasmFunctionSignature | undefined, templateBindings: WasmFunctionSignature): boolean {
    return (!!argument &&
        argument.params.length === templateBindings.params.length &&
        argument.results.length === templateBindings.results.length &&
        argument.params.every((value, parameterIndex) => value === templateBindings.params[parameterIndex]) &&
        argument.results.every((value, resultIndex) => value === templateBindings.results[resultIndex]));
}

export function formatSignature(value: WasmFunctionSignature | undefined): string {
    if (!value)
        return "<unresolved>";
    return `(${value.params.join(", ")}) -> ${value.results.length ? value.results.join(", ") : "void"}`;
}

export function classifyMemory(memories: readonly InspectedWasmMemory[]): InspectedMemoryMode {
    if (memories.length === 0)
        return "none";
    const imported = memories.some((memory) => memory.source === "imported");
    const defined = memories.some((memory) => memory.source === "defined");
    if (imported && defined)
        return "mixed";
    return imported ? "imported" : "defined";
}

export function validateImports(parsed: ParsedModule, lhostAbi: Readonly<Record<string, WasmFunctionSignature>>): void {
    for (const imported of parsed.imports) {
        if (imported.module === "lhost" && imported.kind === "function") {
            const expected = lhostAbi[imported.name];
            if (!expected) {
                error(parsed.diagnostics, "unknown-import", `unknown lhost import '${imported.name}'`);
            }
            else if (!sameSignature(imported.signature, expected)) {
                error(parsed.diagnostics, "import-signature", `lhost.${imported.name} has ${formatSignature(imported.signature)}; expected ${formatSignature(expected)}`);
            }
            continue;
        }
        if (imported.module === "env" && imported.name === "memory" && imported.kind === "memory")
            continue;
        error(parsed.diagnostics, "unknown-import", `unsupported import '${imported.module}.${imported.name}' (${imported.kind})`);
    }
}

export function validateExports(parsed: ParsedModule, mode: InspectedMemoryMode): void {
    const byName = new Map<string, InspectedWasmExport[]>();
    for (const exported of parsed.exports) {
        const values = byName.get(exported.name) ?? [];
        values.push(exported);
        byName.set(exported.name, values);
    }
    for (const [name, values] of byName) {
        if (values.length > 1)
            error(parsed.diagnostics, "duplicate-export", `export '${name}' appears ${values.length} times`);
    }
    for (const [name, expected] of Object.entries(WASM_MODULE_EXPORT_ABI)) {
        const exported = byName.get(name)?.[0];
        if (!exported) {
            error(parsed.diagnostics, "missing-export", `missing required function export '${name}'`);
        }
        else if (exported.kind !== "function") {
            error(parsed.diagnostics, "export-kind", `export '${name}' is ${exported.kind}; expected function`);
        }
        else if (!sameSignature(exported.signature, expected)) {
            error(parsed.diagnostics, "export-signature", `export '${name}' has ${formatSignature(exported.signature)}; expected ${formatSignature(expected)}`);
        }
    }
    if (byName.has("arena_top"))
        error(parsed.diagnostics, "legacy-export", "legacy export 'arena_top' is not supported");
    if (mode === "defined") {
        const memory = byName.get("memory")?.[0];
        if (!memory) {
            error(parsed.diagnostics, "missing-export", "defined-memory contracts must export 'memory'");
        }
        else if (memory.kind !== "memory") {
            error(parsed.diagnostics, "export-kind", `export 'memory' is ${memory.kind}; expected memory`);
        }
        else if (parsed.memories[memory.index]?.source !== "defined") {
            error(parsed.diagnostics, "memory-export", "export 'memory' does not refer to the defined contract memory");
        }
    }
}
