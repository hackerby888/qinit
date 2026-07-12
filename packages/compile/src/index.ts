// Stable public surface for @qinit/compile. Compiler implementation lives under ./compiler.

export type { Span, TypeSpec, Expression, Statement, Declaration, TranslationUnit } from "./ast";
export { Lexer } from "./lexer";
export type { Token, TokenKind } from "./lexer";
export { Preprocessor } from "./preprocess";
export type { PreprocessOpts } from "./preprocess";
export { Parser } from "./parser";
export { formatAst } from "./ast-print";
export { emitFramework, emitModule } from "./framework";
export type { FrameworkOpts, UserEntry, SysProcInfo, ModuleSpec } from "./framework";

export { compileContract, compileGtest, parseToAst } from "./compiler/pipeline";
export type { ParseAstResult } from "./compiler/pipeline";
export { loadQpiHeader, withPrelude } from "./compiler/header";
export {
  inspectLiteWasmModule,
  LHOST_ABI,
  LITE_WASM_FUNCTION_ABI,
} from "./compiler/wasm-inspect";
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
