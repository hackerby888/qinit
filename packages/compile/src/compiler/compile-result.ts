import { type Diagnostic as ParserDiagnostic } from "../parser";
import type { CompileOptions, CompileResult } from "./types";

export function emptyResult(_options: CompileOptions, diagnostics: ParserDiagnostic[], timings?: Record<string, number>): CompileResult {
    return {
        wasm: new Uint8Array(0),
        diagnostics,
        ...(timings ? { timings } : {}),
    };
}
