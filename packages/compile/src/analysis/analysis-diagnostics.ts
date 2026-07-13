import type { Span } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function warn(context: ProgramAnalysisInternals, message: string, at: number | Span): void {
    if ((globalThis as any).process?.env?.QINIT_WARN_TRACE &&
        message.includes((globalThis as any).process.env.QINIT_WARN_TRACE)) {
        console.error(new Error(`TRACE: ${message}`).stack);
    }
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    context.warnings.push({ message, line, column });
}

export function error(context: ProgramAnalysisInternals, message: string, at: number | Span): void {
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    if (context.errors.some((error) => error.message === message && error.line === line && error.column === column)) {
        return;
    }
    context.errors.push({ message, line, column });
}
