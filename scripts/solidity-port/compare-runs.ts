// Comparing two backend runs of the same script, and naming the first point they disagree.

import type { BackendRun, CellResult, ExpectRow, Verdict } from "./types";

function firstDifferingByte(left: string, right: string): string {
    const shared = Math.min(left.length, right.length);
    for (let i = 0; i < shared; i += 2) {
        if (left[i] !== right[i] || left[i + 1] !== right[i + 1]) {
            return `byte ${i / 2}: ${left.slice(i, i + 2)} != ${right.slice(i, i + 2)}`;
        }
    }
    return `length ${left.length / 2} != ${right.length / 2}`;
}

/** The first disagreement between two completed runs, or null when they agree everywhere we look. */
export function compareRuns(ts: BackendRun, clang: BackendRun): string | null {
    if (ts.steps.length !== clang.steps.length) {
        return `step count ${ts.steps.length} != ${clang.steps.length}`;
    }
    for (const [index, left] of ts.steps.entries()) {
        const right = clang.steps[index];
        if ((left.fault === undefined) !== (right.fault === undefined)) {
            return `step ${index} (${left.kind} ${left.entry ?? ""}): fault differs — ts ${left.fault ?? "none"} / clang ${right.fault ?? "none"}`;
        }
        if (left.out !== right.out) {
            return `step ${index} (${left.kind} ${left.entry ?? ""}): output differs at ${firstDifferingByte(left.out ?? "", right.out ?? "")}`;
        }
        const leftLogs = left.logs ?? [];
        const rightLogs = right.logs ?? [];
        if (leftLogs.length !== rightLogs.length) {
            return `step ${index}: log count ${leftLogs.length} != ${rightLogs.length}`;
        }
        for (const [logIndex, leftLog] of leftLogs.entries()) {
            if (leftLog !== rightLogs[logIndex]) return `step ${index}: log ${logIndex} differs — ts ${leftLog} / clang ${rightLogs[logIndex]}`;
        }
        if (left.digest !== right.digest) {
            return `step ${index} (${left.kind} ${left.entry ?? ""}): state digest differs — ts ${left.digest} / clang ${right.digest}`;
        }
    }
    if (ts.stateSize !== clang.stateSize) {
        return `state size ${ts.stateSize} != ${clang.stateSize}`;
    }
    if (ts.digest !== clang.digest) {
        return `final state digest differs — ts ${ts.digest} / clang ${clang.digest}`;
    }
    // A pair's cross-contract writes land in the callee, so the caller's own state can agree while the
    // callee's does not. Checked after the caller so the message names the nearer difference first.
    if (ts.calleeStateSize !== clang.calleeStateSize) {
        return `callee state size ${ts.calleeStateSize} != ${clang.calleeStateSize}`;
    }
    if (ts.calleeDigest !== clang.calleeDigest) {
        return `callee state digest differs — ts ${ts.calleeDigest} / clang ${clang.calleeDigest}`;
    }
    return null;
}

/** Which kind of disagreement this is. A run that never compiled carries its diagnostics instead of a digest, so accept/reject divergence is classified here
 *  rather than being mistaken for a state bug. */
export function classify(ts: BackendRun, clang: BackendRun, difference: string | null): Verdict {
    const tsBuilt = ts.status !== "rejected" && ts.status !== "error";
    const clangBuilt = clang.status !== "rejected" && clang.status !== "error";
    if (!tsBuilt && !clangBuilt) return "both-rejected";
    if (tsBuilt !== clangBuilt) return "one-side-rejected";
    if (ts.status === "trap" || clang.status === "trap") {
        if (ts.status !== clang.status) return "trap-divergence";
    }
    if (difference === null) return "match";
    if (difference.startsWith("final state digest") || difference.startsWith("callee state digest")) return "digest-mismatch";
    if (difference.includes("fault differs")) return "trap-divergence";
    return "step-mismatch";
}

/** The secondary oracle. Only present where the Solidity → QPI width mapping is exact, or where a C++ rule pins the value by hand — it is the only check
 *  that can convict a bug both backends share. */
export function checkExpectations(run: BackendRun, expectations: ExpectRow[] | undefined): string | null {
    if (!expectations?.length) return null;
    for (const row of expectations) {
        const step = run.steps[row.step];
        if (!step) return `expect row ${row.step}: no such step (run stopped after ${run.steps.length})`;
        if (step.out !== row.out) {
            return `expect row ${row.step} (${row.source}: ${row.note}): output ${step.out} != expected ${row.out}`;
        }
    }
    return null;
}

/** One-line summary of a cell, for the sweep's streaming output. */
export function describeCell(cell: CellResult): string {
    const flag = cell.verdict === "match" ? "ok  " : "FAIL";
    const detail = cell.verdict === "match" ? "" : ` — ${cell.verdict}${cell.firstDifference ? `: ${cell.firstDifference}` : ""}`;
    return `${flag} ${cell.id} (${cell.totalMs}ms)${detail}`;
}
