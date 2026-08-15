// Stable public surface for @qinit/compiler. Compiler implementation lives under ./compiler.
import { compileContract as compileContractWithHeader, compileGtest as compileGtestWithHeader, parseToAst as parseToAstWithHeader } from "./driver/pipeline";
import { loadQpiHeader } from "./driver/header";
import type { CompileOptions, CompileResult, GtestCompileResult } from "./driver/types";

export { DEFAULT_COMPILE_ARENA_SIZE_BYTES } from "./driver/defaults";

export * from "./shared/enums";
export type { Span, TypeSpec, Expression, Statement, Declaration, TranslationUnit } from "./ast";
export { Lexer, TokenKind } from "./frontend/lexer";
export type { Token } from "./frontend/lexer";
export { Preprocessor } from "./frontend/preprocessor";
export type { PreprocessOptions } from "./frontend/preprocessor";
export { Parser } from "./frontend/parser";
export { formatAst } from "./ast/print";
export { emitFramework, emitModule } from "./backend/wasm/framework";
export type { FrameworkOptions, UserEntry, SystemProcedureInfo, ModuleSpecification } from "./backend/wasm/framework";

export type { ParseAstResult } from "./driver/pipeline";
export { loadQpiHeader, withPrelude } from "./driver/header";
export { snapshotInputFiles } from "./driver/qpi/snapshot";

export async function compileContract(options: CompileOptions): Promise<CompileResult> {
    return compileContractWithHeader({
        ...options,
        qpiHeader: options.qpiHeader ?? loadQpiHeader(),
    });
}

export async function compileGtest(options: CompileOptions & { testSource: string }): Promise<GtestCompileResult> {
    return compileGtestWithHeader({ ...options, qpiHeader: options.qpiHeader ?? loadQpiHeader() });
}

export function parseToAst(options: Parameters<typeof parseToAstWithHeader>[0]): ReturnType<typeof parseToAstWithHeader> {
    return parseToAstWithHeader({ ...options, qpiHeader: options.qpiHeader ?? loadQpiHeader() });
}
export { inspectWasmModule, LHOST_ABI, WASM_MODULE_EXPORT_ABI } from "./driver/wasm-inspect";
export type {
    InspectedWasmExport,
    InspectedWasmImport,
    InspectedWasmMemory,
    WasmModuleInspection,
    WasmModuleInspectionOptions,
    WasmFunctionSignature,
    WasmInspectionDiagnostic,
} from "./driver/wasm-inspect";
export type { CompileOptions, CompileResult, ContractIdl, Diagnostic, GtestCompileResult, GtestDiagnostic, GtestProgram } from "./driver/types";
