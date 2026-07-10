// @qinit/compile/browser — the browser entry. Embeds the generated QPI header snapshot so callers
// compile without providing qpiHeader (an explicit override is still honored, for compiler tests
// and compatibility experiments). The snapshot module is produced by tools/gen-qpi-snapshot.ts
// from the core checkout pinned in core-snapshot.json; it is gitignored, so a build that starts
// without it fails at resolve time — run the generator (or the IDE's dev preparation) first.
import type { CompileOpts, CompileResult, ContractIdl, CalleeIdl } from "./index";
import { compileContract as compileWithHeader } from "./index";
import { QPI_SNAPSHOT, QPI_SNAPSHOT_META } from "../.generated/qpi-snapshot";

export type { CompileOpts, CompileResult, ContractIdl, CalleeIdl } from "./index";
export type { Diagnostic as CompileDiagnostic } from "./parser";

// Bumped when the compile request/result contract visible to embedders (worker protocols, IDE
// facades) changes incompatibly — lets a host detect a too-old or too-new compiler package.
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
