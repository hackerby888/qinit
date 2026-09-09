import type { ContractIdl } from "./idl";
import type { VerifyResult } from "./verify";

export interface ContractBuildResult {
    ok: boolean;
    wasmPath?: string;
    wasmSizeBytes?: number;
    wasmK12DigestHex?: string;
    idl?: ContractIdl;
    verify?: VerifyResult;
    debugWasmPath?: string; // -g DWARF sidecar (deployed wasm is stripped)
    lineMapPath?: string; // {fileOffset -> file:line:func} map for source-mapped trap backtraces
    stderr?: string;
    idlError?: string; // set (instead of silently dropping idl) when extractIdl throws on a compiled contract
    // Non-fatal findings from the build gate (build-rules.ts BUILD_WARN_RULES) plus the cheat guards a
    // --production build removed. The build succeeded; these say what shipped is not what was written.
    warnings?: string[];
    strippedCheats?: string[]; // --production only: the CC_* guards removed from the source that shipped
}

export type SystemContractCompiler = "clang" | "typescript";
