// One differential cell: compile a ported contract with both backends, drive both with the same call
// script, and compare. This is the unit the sweep parallelises over and the unit triage re-runs.

import { compileWithClang, compileWithTypeScript, type CompileEnvironment } from "./compile";
import { compareRuns, checkExpectations, classify } from "./compare-runs";
import { executeScript } from "./execute";
import type { BackendRun, CallScript, CellResult, Family, AxisAssignment } from "./types";

export interface CellInput {
    id: string;
    archetype: string;
    family: Family;
    axis: AxisAssignment;
    contractName: string;
    source: string;
    script: CallScript;
    /** Set when the archetype exists to prove both backends refuse the contract. */
    expectReject?: boolean;
}

function rejected(backend: BackendRun["backend"], diagnostics: string[], compileMs: number, cached: boolean): BackendRun {
    return { backend, status: "rejected", steps: [], diagnostics, compileMs, executeMs: 0, cached };
}

export async function runCell(env: CompileEnvironment, input: CellInput): Promise<CellResult> {
    const started = Date.now();
    const [tsCompile, clangCompile] = await Promise.all([
        compileWithTypeScript(env, input.source, input.contractName, input.script.slot),
        compileWithClang(env, input.source, input.contractName, input.script.slot),
    ]);

    let ts: BackendRun;
    let clang: BackendRun;
    if (tsCompile.ok && tsCompile.wasm) {
        ts = { ...executeScript("typescript", tsCompile.wasm, input.script), compileMs: tsCompile.ms, cached: tsCompile.cached };
    } else {
        ts = rejected("typescript", tsCompile.diagnostics, tsCompile.ms, tsCompile.cached);
    }
    if (clangCompile.ok && clangCompile.wasm) {
        clang = { ...executeScript("clang", clangCompile.wasm, input.script), compileMs: clangCompile.ms, cached: clangCompile.cached };
    } else {
        clang = rejected("clang", clangCompile.diagnostics, clangCompile.ms, clangCompile.cached);
    }

    const bothBuilt = tsCompile.ok && clangCompile.ok;
    const difference = bothBuilt ? compareRuns(ts, clang) : null;
    let verdict = classify(ts, clang, difference);
    let firstDifference = difference ?? undefined;

    // An archetype written to be refused inverts the verdict: agreeing on rejection is the pass.
    if (input.expectReject) {
        if (verdict === "both-rejected") {
            verdict = "match";
            firstDifference = undefined;
        } else if (verdict === "match") {
            verdict = "one-side-rejected";
            firstDifference = "expected both backends to reject this contract; both accepted it";
        }
    }

    // The secondary oracle runs only once the backends already agree — otherwise the disagreement is
    // the story, and a shared-wrong-answer check would just add noise to it.
    if (verdict === "match" && bothBuilt) {
        const violated = checkExpectations(ts, input.script.expect);
        if (violated) {
            verdict = "expect-violation";
            firstDifference = violated;
        }
    }

    return {
        id: input.id,
        archetype: input.archetype,
        family: input.family,
        axis: input.axis,
        verdict,
        firstDifference,
        ts,
        clang,
        totalMs: Date.now() - started,
    };
}
