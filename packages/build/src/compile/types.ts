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
}

export type SystemContractCompiler = "clang" | "typescript";
