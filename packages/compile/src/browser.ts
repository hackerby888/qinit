// Browser entry for @qinit/compile.
import type { CompileOptions, CompileResult, ContractIdl, CalleeIdl, GtestCompileResult } from "./compiler/types";
import { compileContract as compileWithHeader, compileGtest as compileGtestWithHeader } from "./compiler/pipeline";
import { QPI_SNAPSHOT, QPI_SNAPSHOT_META } from "./generated/qpi-snapshot";

export type {
  CompileOptions,
  CompileResult,
  ContractIdl,
  CalleeIdl,
  GtestCompileResult,
  GtestProgram,
} from "./compiler/types";
export type { Diagnostic as CompileDiagnostic } from "./parser";
export { inspectLiteWasmModule, LHOST_ABI, LITE_WASM_FUNCTION_ABI } from "./compiler/wasm-inspect";
export type {
  LiteWasmInspection,
  LiteWasmInspectionOptions,
  WasmInspectionDiagnostic,
} from "./compiler/wasm-inspect";

// Bumped when the compile request/result contract visible to embedders (worker protocols, IDE facades) changes incompatibly — lets a
export const COMPILER_PROTOCOL_VERSION = 2;

export interface CompilerInfo {
  qinitVersion: string;
  coreCommit: string;
  snapshotHash: string;
  generatorVersion: number;
  protocolVersion: number;
}

export const compilerInfo: CompilerInfo = {
  qinitVersion: QPI_SNAPSHOT_META.qinitCompileVersion,
  coreCommit: QPI_SNAPSHOT_META.coreCommit,
  snapshotHash: QPI_SNAPSHOT_META.snapshotHash,
  generatorVersion: QPI_SNAPSHOT_META.generatorVersion,
  protocolVersion: COMPILER_PROTOCOL_VERSION,
};

export const qpiSnapshot: string = QPI_SNAPSHOT;

export type BrowserCompileOptions = Omit<CompileOptions, "qpiHeader"> & { qpiHeader?: string };

export async function compileContract(options: BrowserCompileOptions): Promise<CompileResult> {
  return compileWithHeader({ ...options, qpiHeader: options.qpiHeader ?? QPI_SNAPSHOT });
}

export async function compileGtest(
  options: BrowserCompileOptions & { testSource: string },
): Promise<GtestCompileResult> {
  return compileGtestWithHeader({ ...options, qpiHeader: options.qpiHeader ?? QPI_SNAPSHOT });
}
