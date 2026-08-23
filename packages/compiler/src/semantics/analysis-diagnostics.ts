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

// A construct that lowers correctly but is non-canonical. Deduplicated: a type used fifty times
// should not produce fifty warnings.
export function advise(programAnalysis: ProgramAnalysis, message: string, at: number | Span): void {
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    if (programAnalysis.warnings.some((warning) => warning.message === message && warning.line === line && warning.column === column)) {
        return;
    }
    programAnalysis.warnings.push({ message, line, column, advisory: true });
}

export function error(programAnalysis: ProgramAnalysis, message: string, at: number | Span): void {
    const line = typeof at === "number" ? at : at.line;
    const column = typeof at === "number" ? 0 : at.column;
    if (programAnalysis.errors.some((error) => error.message === message && error.line === line && error.column === column)) {
        return;
    }
    programAnalysis.errors.push({ message, line, column });
}

// The first diagnostic since a baseline that means a body was not lowered faithfully, or null.
// Advisories are skipped: they describe style, not fidelity, so they must not fail an authoritative body.
export function firstInfidelitySince(programAnalysis: ProgramAnalysis, warningBase: number, errorBase: number): string | null {
    const failedError = programAnalysis.errors[errorBase];
    if (failedError) {
        return failedError.message;
    }
    const failedWarning = programAnalysis.warnings.slice(warningBase).find((warning) => !warning.advisory);
    return failedWarning ? failedWarning.message : null;
}
