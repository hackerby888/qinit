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
    // non-fatal findings (build-rules.ts BUILD_WARN_RULES): the build succeeded, but what shipped is not what was written.
    warnings?: string[];
    strippedCheats?: string[]; // --production only: the CC_* guards removed from the source that shipped
}

export type SystemContractCompiler = "clang" | "typescript";
