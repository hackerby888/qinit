// Browser entry for @qinit/compiler. Same exported names as the root entry, but the QPI header comes from the
// generated snapshot instead of disk — `contractPath`/`corePath` have no meaning without a filesystem.
import type { CompileOptions, CompileResult, GtestCompileResult } from "./driver/types";
import { compileContract } from "./driver/compile-contract";
import { compileGtest } from "./driver/gtest";
import { QPI_SNAPSHOT, QPI_SNAPSHOT_META } from "./generated/qpi-snapshot";

export * from "./shared/enums";
export type { CompileOptions, CompileResult, CompileDiagnostic, ContractIdl, GtestCompileResult, GtestProgram } from "./driver/types";
export { inspectWasmModule, LHOST_ABI, WASM_MODULE_EXPORT_ABI } from "./driver/wasm-inspection";
export type { WasmModuleInspection, WasmModuleInspectionOptions, WasmInspectionDiagnostic } from "./driver/wasm-inspection";

// Increment when the public compile protocol changes incompatibly.
export const COMPILER_PROTOCOL_VERSION = 3;

export interface CompilerInfo {
    qinitVersion: string;
    coreCommit: string;
    snapshotHash: string;
    generatorVersion: number;
    protocolVersion: number;
}

export const compilerInfo: CompilerInfo = {
    qinitVersion: QPI_SNAPSHOT_META.qinitCompilerVersion,
    coreCommit: QPI_SNAPSHOT_META.coreCommit,
    snapshotHash: QPI_SNAPSHOT_META.snapshotHash,
    generatorVersion: QPI_SNAPSHOT_META.generatorVersion,
    protocolVersion: COMPILER_PROTOCOL_VERSION,
};

export const qpiSnapshot: string = QPI_SNAPSHOT;

export type BrowserCompileOptions = Omit<CompileOptions, "qpiHeader"> & { qpiHeader?: string };

// The root entry's contractPath/corePath need a filesystem. Untyped JS callers would otherwise get the
// generic "source is required" diagnostic and no hint that they picked the wrong entry.
function browserOptions(options: BrowserCompileOptions): CompileOptions {
    const filesystemOnly = ["contractPath", "corePath"].filter((key) => (options as Record<string, unknown>)[key] !== undefined);
    if (filesystemOnly.length) {
        throw new Error(`${filesystemOnly.join(" and ")} cannot be read in a browser; pass \`source\` (and \`qpiHeader\` to override the bundled snapshot)`);
    }
    return { ...options, qpiHeader: options.qpiHeader ?? QPI_SNAPSHOT };
}

export async function compileContractWithTypeScript(options: BrowserCompileOptions): Promise<CompileResult> {
    return compileContract(browserOptions(options));
}

export async function compileGtestWithTypeScript(options: BrowserCompileOptions & { testSource: string }): Promise<GtestCompileResult> {
    return compileGtest({ ...browserOptions(options), testSource: options.testSource });
}
