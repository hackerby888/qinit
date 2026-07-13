import { type Diagnostic as ParserDiagnostic } from "../parser";
import type { CompileOptions, CompileResult } from "./types";

export function emptyResult(options: CompileOptions, diagnostics: ParserDiagnostic[], timings?: Record<string, number>): CompileResult {
    return {
        wasm: new Uint8Array(0),
        diagnostics,
        idl: {
            name: options.name,
            slot: options.slot,
            functions: [],
            procedures: [],
            stateSize: 0,
            sysprocMask: 0,
        },
        ...(timings ? { timings } : {}),
    };
}
