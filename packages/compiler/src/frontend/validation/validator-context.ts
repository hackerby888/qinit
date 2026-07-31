import { DiagnosticSeverity } from "../../enums";
// Validation runs after parse and before codegen.
import type { FunctionDecl, Span } from "../../ast";
export interface ValidateDiagnostic {
    severity: DiagnosticSeverity.ERROR;
    message: string;
    span: Span;
}
export interface FnSig {
    declaration: FunctionDecl;
    minArgs: number;
    maxArgs: number;
}


export type { Validator as ValidatorInternals } from "./validator";
