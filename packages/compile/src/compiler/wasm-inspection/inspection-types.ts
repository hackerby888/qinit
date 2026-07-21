
// Static inspection for the dynamic-contract Wasm ABI.
// Parse bytes without instantiation so signature checks stay stable across engines.
export type WasmValueType = "i32" | "i64" | "f32" | "f64";

export interface WasmFunctionSignature {
    readonly params: readonly WasmValueType[];
    readonly results: readonly WasmValueType[];
}

export type WasmExternalKind = "function" | "table" | "memory" | "global" | "tag";

export interface InspectedWasmImport {
    readonly module: string;
    readonly name: string;
    readonly kind: WasmExternalKind;
    readonly signature?: WasmFunctionSignature;
}

export interface InspectedWasmExport {
    readonly name: string;
    readonly kind: WasmExternalKind;
    readonly index: number;
    readonly signature?: WasmFunctionSignature;
}

export interface InspectedWasmMemory {
    readonly source: "imported" | "defined";
    readonly module?: string;
    readonly name?: string;
    readonly minimumPages: bigint;
    readonly maximumPages?: bigint;
    readonly shared: boolean;
    readonly memory64: boolean;
}

export type WasmModuleMemoryMode = "defined" | "imported" | "either";

export type InspectedMemoryMode = "none" | "defined" | "imported" | "mixed";

export interface WasmInspectionDiagnostic {
    readonly severity: "error";
    readonly code: string;
    readonly message: string;
    readonly offset?: number;
}

export interface WasmModuleInspectionOptions {
    /** Production contracts define memory; shared-memory gtests import env.memory. */
    readonly memoryMode?: WasmModuleMemoryMode;
    /** Parsed live-core imports used by Node compilation; defaults to the generated browser ABI. */
    readonly lhostAbi?: Readonly<Record<string, WasmFunctionSignature>>;
}

export interface WasmModuleInspection {
    readonly ok: boolean;
    readonly diagnostics: readonly WasmInspectionDiagnostic[];
    readonly imports: readonly InspectedWasmImport[];
    readonly exports: readonly InspectedWasmExport[];
    readonly memories: readonly InspectedWasmMemory[];
    readonly memoryMode: InspectedMemoryMode;
    readonly features: readonly string[];
}

export const signature = (params: readonly WasmValueType[] = [], results: readonly WasmValueType[] = []): WasmFunctionSignature => Object.freeze({ params: Object.freeze([...params]), results: Object.freeze([...results]) });

export const I32 = "i32" as const;

export const I64 = "i64" as const;

// Enabled by both JavaScript engines and WAMR's interpreter in the release node.
// Keep this deliberately narrow; every other detected post-MVP feature fails closed.
export const PORTABLE_FEATURES = new Set(["bulk-memory", "sign-extension-operators"]);

/** Function exports consumed by the Qinit engine and core-lite dynamic loader. */
export const WASM_MODULE_EXPORT_ABI: Readonly<Record<string, WasmFunctionSignature>> = Object.freeze({
    contract_index: signature([], [I32]),
    state_addr: signature([], [I32]),
    state_size: signature([], [I32]),
    io_base: signature([], [I32]),
    io_size: signature([], [I32]),
    ctx_addr: signature([], [I32]),
    reg_count: signature([], [I32]),
    reg_info: signature([I32, I32]),
    reg_sysproc_mask: signature([], [I32]),
    sysproc_locals_size: signature([I32], [I32]),
    sysproc_in_size: signature([I32], [I32]),
    sysproc_out_size: signature([I32], [I32]),
    has_migrate: signature([], [I32]),
    migrate_old_state_size: signature([], [I32]),
    migrate_locals_size: signature([], [I32]),
    dispatch: signature([I32, I32, I32, I32, I32]),
    _initialize: signature(),
});
