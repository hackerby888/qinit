// Stable public surface for @qinit/compile. Compiler implementation lives under ./compiler.

export { QPI_STUB } from "./qpi-stub";

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
export type {
  CalleeIdl,
  CompileOpts,
  CompileResult,
  ContractIdl,
  Diagnostic,
} from "./compiler/types";
