// Stable public surface for @qinit/compile. Compiler implementation lives under ./compiler.

import {
  compileContract as compileContractWithHeader,
  compileGtest as compileGtestWithHeader,
  parseToAst as parseToAstWithHeader,
} from "./compiler/pipeline";
import { loadQpiHeader } from "./compiler/header";
import type { CompileOpts, CompileResult, GtestCompileResult } from "./compiler/types";

export type { Span, TypeSpec, Expression, Statement, Declaration, TranslationUnit } from "./ast";
export { Lexer } from "./lexer";
export type { Token, TokenKind } from "./lexer";
export { Preprocessor } from "./preprocess";
export type { PreprocessOpts } from "./preprocess";
export { Parser } from "./parser";
export { formatAst } from "./ast-print";
export { emitFramework, emitModule } from "./framework";
export type { FrameworkOpts, UserEntry, SysProcInfo, ModuleSpec } from "./framework";

export type { ParseAstResult } from "./compiler/pipeline";
export { loadQpiHeader, withPrelude } from "./compiler/header";

export async function compileContract(opts: CompileOpts): Promise<CompileResult> {
  return compileContractWithHeader({ ...opts, qpiHeader: opts.qpiHeader ?? loadQpiHeader() });
}

export async function compileGtest(
  opts: CompileOpts & { testSource: string },
): Promise<GtestCompileResult> {
  return compileGtestWithHeader({ ...opts, qpiHeader: opts.qpiHeader ?? loadQpiHeader() });
}

export function parseToAst(
  opts: Parameters<typeof parseToAstWithHeader>[0],
): ReturnType<typeof parseToAstWithHeader> {
  return parseToAstWithHeader({ ...opts, qpiHeader: opts.qpiHeader ?? loadQpiHeader() });
}
export { inspectLiteWasmModule, LHOST_ABI, LITE_WASM_FUNCTION_ABI } from "./compiler/wasm-inspect";
export type {
  InspectedMemoryMode,
  InspectedWasmExport,
  InspectedWasmImport,
  InspectedWasmMemory,
  LiteWasmInspection,
  LiteWasmInspectionOptions,
  LiteWasmMemoryMode,
  WasmExternalKind,
  WasmFunctionSignature,
  WasmInspectionDiagnostic,
  WasmValueType,
} from "./compiler/wasm-inspect";
export type {
  CalleeIdl,
  CompileOpts,
  CompileResult,
  ContractIdl,
  Diagnostic,
  GtestCompileResult,
  GtestDiagnostic,
  GtestProgram,
} from "./compiler/types";
