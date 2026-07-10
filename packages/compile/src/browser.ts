// Browser entry for @qinit/compile.
import type { CompileOpts, CompileResult, ContractIdl, CalleeIdl } from "./index";
import { compileContract as compileWithHeader } from "./index";
import { QPI_SNAPSHOT, QPI_SNAPSHOT_META } from "../.generated/qpi-snapshot";

export type { CompileOpts, CompileResult, ContractIdl, CalleeIdl } from "./index";
export type { Diagnostic as CompileDiagnostic } from "./parser";

// Bumped when the compile request/result contract visible to embedders (worker protocols, IDE facades) changes incompatibly — lets a
export const COMPILER_PROTOCOL_VERSION = 1;

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

export type BrowserCompileOpts = Omit<CompileOpts, "qpiHeader"> & { qpiHeader?: string };

export async function compileContract(opts: BrowserCompileOpts): Promise<CompileResult> {
  return compileWithHeader({ ...opts, qpiHeader: opts.qpiHeader ?? QPI_SNAPSHOT });
}
