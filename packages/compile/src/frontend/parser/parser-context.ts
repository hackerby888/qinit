import {
    DiagnosticCategory,
    DiagnosticSeverity,
} from "../../enums";
import type { Span } from "../../ast";

export interface ParserDiagnostic {
    severity: DiagnosticSeverity.ERROR | DiagnosticSeverity.WARNING;
    message: string;
    span: Span;
    category?: DiagnosticCategory.FIDELITY;
}
