// Stable public surface for @qinit/compile. Compiler implementation lives under ./compiler.
import { compileContract as compileContractWithHeader, compileGtest as compileGtestWithHeader, parseToAst as parseToAstWithHeader } from "./compiler/pipeline";
import { loadQpiHeader } from "./compiler/header";
import type { CompileOptions, CompileResult, GtestCompileResult } from "./compiler/types";

export type { Span, TypeSpec, Expression, Statement, Declaration, TranslationUnit } from "./ast";
export { Lexer } from "./lexer";
export type { Token, TokenKind } from "./lexer";
export { Preprocessor } from "./preprocess";
export type { PreprocessOptions } from "./preprocess";
export { Parser } from "./parser";
export { formatAst } from "./ast-print";
export { emitFramework, emitModule } from "./framework";
export type { FrameworkOptions, UserEntry, SystemProcedureInfo, ModuleSpecification } from "./framework";

export type { ParseAstResult } from "./compiler/pipeline";
export { loadQpiHeader, withPrelude } from "./compiler/header";

export async function compileContract(options: CompileOptions): Promise<CompileResult> {
  return compileContractWithHeader({ ...options, qpiHeader: options.qpiHeader ?? loadQpiHeader() });
}

export async function compileGtest(
  options: CompileOptions & { testSource: string },
): Promise<GtestCompileResult> {
  return compileGtestWithHeader({ ...options, qpiHeader: options.qpiHeader ?? loadQpiHeader() });
}

export function parseToAst(
  options: Parameters<typeof parseToAstWithHeader>[0],
): ReturnType<typeof parseToAstWithHeader> {
  return parseToAstWithHeader({ ...options, qpiHeader: options.qpiHeader ?? loadQpiHeader() });
}
export { inspectWasmModule, LHOST_ABI, WASM_MODULE_EXPORT_ABI } from "./compiler/wasm-inspect";
export type {
  InspectedMemoryMode,
  InspectedWasmExport,
  InspectedWasmImport,
  InspectedWasmMemory,
  WasmModuleInspection,
  WasmModuleInspectionOptions,
  WasmModuleMemoryMode,
  WasmExternalKind,
  WasmFunctionSignature,
  WasmInspectionDiagnostic,
  WasmValueType,
} from "./compiler/wasm-inspect";
export type {
  CalleeIdl,
  CompileOptions,
  CompileResult,
  ContractIdl,
  Diagnostic,
  GtestCompileResult,
  GtestDiagnostic,
  GtestProgram,
} from "./compiler/types";
