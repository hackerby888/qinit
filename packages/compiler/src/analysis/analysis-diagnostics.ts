import type { Span } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function warn(programAnalysis: ProgramAnalysis, message: string, at: number | Span): void {
    if ((globalThis as any).process?.env?.QINIT_WARN_TRACE && message.includes((globalThis as any).process.env.QINIT_WARN_TRACE)) {
        console.error(new Error(`TRACE: ${message}`).stack);
    }
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    programAnalysis.warnings.push({ message, line, column });
}

export function error(programAnalysis: ProgramAnalysis, message: string, at: number | Span): void {
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    if (programAnalysis.errors.some((error) => error.message === message && error.line === line && error.column === column)) {
        return;
    }
    programAnalysis.errors.push({ message, line, column });
}
