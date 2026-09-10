// One differential cell: compile a ported contract — or a caller/callee pair — with both backends,
// drive both with the same call script, and compare. This is the unit the sweep parallelises over and
// the unit triage re-runs.

import { compileWith, type CompileEnvironment, type CompileRequest } from "./compile";
import { compareRuns, checkExpectations, classify } from "./compare-runs";
import { executeScript } from "./execute";
import type { BackendRun, CallScript, CellResult, Family, AxisAssignment, Verdict } from "./types";

export interface CellInput {
    id: string;
    archetype: string;
    family: Family;
    axis: AxisAssignment;
    contractName: string;
    source: string;
    script: CallScript;
    /** The callee this contract calls, at a strictly lower slot. */
    callee?: { name: string; source: string; slot: number };
    /** Set when the archetype exists to prove both backends refuse the contract. */
    expectReject?: boolean;
    /** A divergence the archetype exists to pin; diverging exactly this way is the pass. */
    expectedVerdict?: Verdict;
    divergenceNote?: string;
}

function rejected(backend: BackendRun["backend"], diagnostics: string[], compileMs: number, cached: boolean): BackendRun {
    return { backend, status: "rejected", steps: [], diagnostics, compileMs, executeMs: 0, cached };
}

export async function runCell(env: CompileEnvironment, input: CellInput): Promise<CellResult> {
    const started = Date.now();
    const request: CompileRequest = {
        main: { name: input.contractName, source: input.source, slot: input.script.slot },
        ...(input.callee ? { callee: input.callee } : {}),
    };
    const [tsBuild, clangBuild] = await Promise.all([compileWith(env, "typescript", request), compileWith(env, "clang", request)]);

    const runFor = (backend: BackendRun["backend"], build: typeof tsBuild): BackendRun => {
        if (!build.main.ok || !build.main.wasm) return rejected(backend, build.main.diagnostics, build.main.ms, build.main.cached);
        const callee = input.callee && build.callee?.ok && build.callee.wasm ? { slot: input.callee.slot, wasm: build.callee.wasm } : undefined;
        return { ...executeScript(backend, build.main.wasm, input.script, callee), compileMs: build.main.ms, cached: build.main.cached };
    };
    const ts = runFor("typescript", tsBuild);
    const clang = runFor("clang", clangBuild);

    const bothBuilt = tsBuild.main.ok && clangBuild.main.ok;
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

    // An archetype that documents a known divergence passes by diverging exactly that way, and fails if
    // it ever stops — a regression test rather than a permanent red row on the scoreboard.
    if (input.expectedVerdict) {
        if (verdict === input.expectedVerdict) {
            verdict = "match";
            firstDifference = `documented divergence held: ${input.divergenceNote ?? input.expectedVerdict}`;
        } else {
            firstDifference = `expected the documented divergence '${input.expectedVerdict}' but got '${verdict}'${difference ? `: ${difference}` : ""}`;
            verdict = "expect-violation";
        }
    }

    // The secondary oracle runs only once the backends already agree — otherwise the disagreement is
    // the story, and a shared-wrong-answer check would just add noise to it.
    if (verdict === "match" && bothBuilt && !input.expectedVerdict) {
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
