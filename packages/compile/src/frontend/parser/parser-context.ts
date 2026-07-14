import type { Span } from "../../ast";

export interface ParserDiagnostic {
    severity: "error" | "warning";
    message: string;
    span: Span;
    category?: "fidelity";
}
