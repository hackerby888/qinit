import type { InspectedWasmExport, InspectedWasmImport, InspectedWasmMemory, WasmFunctionSignature, WasmInspectionDiagnostic, WasmValueType } from "./inspection-types";

export interface InternalGlobal {
    type: WasmValueType;
    mutable: boolean;
}

export interface ParsedModule {
    types: WasmFunctionSignature[];
    functionTypeIndices: number[];
    globals: InternalGlobal[];
    imports: InspectedWasmImport[];
    exports: InspectedWasmExport[];
    memories: InspectedWasmMemory[];
    features: Set<string>;
    diagnostics: WasmInspectionDiagnostic[];
    definedFunctionCount: number;
    tableCount: number;
}

export function emptyParsed(): ParsedModule {
    return {
        types: [],
        functionTypeIndices: [],
        globals: [],
        imports: [],
        exports: [],
        memories: [],
        features: new Set(),
        diagnostics: [],
        definedFunctionCount: 0,
        tableCount: 0,
    };
}
