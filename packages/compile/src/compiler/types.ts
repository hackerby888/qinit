import {
  DiagnosticCategory,
  DiagnosticSeverity,
} from "../enums";
import type { Span } from "../ast";
import type { Diagnostic as ParserDiagnostic } from "../parser";
import type { ContractIdl } from "@qinit/proto/contract-idl";

export type { ContractIdl } from "@qinit/proto/contract-idl";

export interface CompileOptions {
  source: string;
  name: string;
  slot: number;
  arenaSz?: number;
  callees?: ContractIdl[];
  calleeSources?: Array<{
    name: string;
    source: string;
    slot?: number;
  }>;
  testSource?: string;
  testPath?: string;
  qpiHeader?: string;
  sharedMemBase?: number;
  onPhase?: (phase: string) => void | Promise<void>;
  strict?: boolean;
  constructionEpoch?: number;
}

export interface CompileResult {
  wasm: Uint8Array;
  diagnostics: ParserDiagnostic[];
  idl?: ContractIdl;
  timings?: Record<string, number>;
}

export interface GtestProgram {
  version: 2;
  contract: string;
  mainSlot: number;
  runnerSlot: number;
  mainConstructionEpoch: number;
  tests: Array<{ name: string; inputType: number }>;
}

export type GtestDiagnostic = ParserDiagnostic;

export interface GtestCompileResult {
  wasm?: Uint8Array;
  program?: GtestProgram;
  diagnostics: GtestDiagnostic[];
  idl?: ContractIdl;
}

export interface Diagnostic {
  severity: DiagnosticSeverity.ERROR | DiagnosticSeverity.WARNING;
  message: string;
  file?: string;
  span: Span;
  category?: DiagnosticCategory.FIDELITY;
}
