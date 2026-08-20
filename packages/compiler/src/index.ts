// Stable public surface for @qinit/compiler — the in-process TypeScript backend, paired with
// buildContractWithClang in @qinit/build. The compiler itself lives under ./driver and ./backend.
import { readFileSync } from "node:fs";
import { compileContract } from "./driver/compile-contract";
import { compileGtest } from "./driver/gtest";
import { parseToAst } from "./driver/parse-ast";
import type { ParseAstResult } from "./driver/parse-ast";
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
export { emitModule } from "./backend/wasm/framework";
export type { UserEntry, SystemProcedureInfo, ModuleSpecification } from "./backend/wasm/framework";
export { LOG_HEADER_WORD_HINT } from "./backend/wasm/abi/log-payload";

export type { ParseAstResult } from "./driver/parse-ast";
export { loadQpiHeader, withPrelude } from "./driver/header";
export { snapshotInputFiles } from "./driver/qpi/snapshot";

// Accepts source text or a contract path, so one options object drives this backend or buildContractWithClang.
// `qpiHeader` wins over `corePath`; with neither, loadQpiHeader falls back to QINIT_CORE.
export type TypeScriptCompileOptions = Omit<CompileOptions, "source"> & {
    source?: string;
    contractPath?: string;
    corePath?: string;
};

function resolveOptions(options: TypeScriptCompileOptions): CompileOptions {
    const { contractPath, corePath, ...rest } = options;
    if (options.source === undefined && !contractPath) {
        throw new Error("compile needs either `source` or `contractPath`");
    }
    return {
        ...rest,
        source: options.source ?? readFileSync(contractPath!, "utf8"),
        qpiHeader: options.qpiHeader ?? loadQpiHeader(corePath),
    };
}

export async function compileContractWithTypeScript(options: TypeScriptCompileOptions): Promise<CompileResult> {
    return compileContract(resolveOptions(options));
}

export async function compileGtestWithTypeScript(options: TypeScriptCompileOptions & { testSource: string }): Promise<GtestCompileResult> {
    return compileGtest({ ...resolveOptions(options), testSource: options.testSource });
}

// Parsing needs no slot or contract name, so this keeps the driver's looser shape rather than CompileOptions.
export function parseToAstWithTypeScript(options: {
    source: string;
    contractName?: string;
    slot?: number;
    qpiHeader?: string;
    corePath?: string;
}): ParseAstResult {
    return parseToAst({ ...options, qpiHeader: options.qpiHeader ?? loadQpiHeader(options.corePath) });
}
export { inspectWasmModule, LHOST_ABI, WASM_MODULE_EXPORT_ABI } from "./driver/wasm-inspection";
export type {
    InspectedWasmExport,
    InspectedWasmImport,
    InspectedWasmMemory,
    WasmModuleInspection,
    WasmModuleInspectionOptions,
    WasmFunctionSignature,
    WasmInspectionDiagnostic,
} from "./driver/wasm-inspection";
export type { CompileOptions, CompileResult, CompileDiagnostic, ContractIdl, GtestCompileResult, GtestDiagnostic, GtestProgram } from "./driver/types";
