// Controls for the Solidity-port differential campaign (scripts/solidity-port/, corpus/solidity-port/).
//
// A differential suite that cannot fail reports nothing, and this repo has already shipped one that sat
// green for months asserting hand-written expectations which encoded a bug. So the first half of this
// file never touches a compiler: it feeds the comparator deliberately broken pairs and asserts the exact
// message each one produces. If the digest were computed and never compared — the classic way a sweep
// goes silently vacuous — `reports a digest difference even when every step agrees` fails.
//
// The second half runs a slice of the real corpus through both backends, and skips only when the wasm
// toolchain is genuinely absent. Set QINIT_REQUIRE_CONTAINER_TOOLCHAINS=1 to turn that skip into a failure.

import { describe, expect, test, beforeAll } from "bun:test";
import { initK12 } from "@qinit/engine";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { toolchainTest, wasiToolchain } from "../support/container-toolchains";
import { compareRuns, classify } from "../../../../scripts/solidity-port/compare-runs";
import { environmentFor } from "../../../../scripts/solidity-port/compile";
import { runCell } from "../../../../scripts/solidity-port/cell";
import { executeScript } from "../../../../scripts/solidity-port/execute";
import { compileWith } from "../../../../scripts/solidity-port/compile";
import { expandAll } from "../../../../scripts/solidity-port/registry";
import type { BackendRun, StepRecord } from "../../../../scripts/solidity-port/types";

function run(backend: BackendRun["backend"], steps: StepRecord[], digest: string, stateSize = 32): BackendRun {
    return { backend, status: "ok", digest, stateSize, steps, compileMs: 0, executeMs: 0 };
}

/** A caller/callee pair's run: the callee's own digest travels alongside the caller's. */
function pairRun(backend: BackendRun["backend"], digest: string, calleeDigest: string): BackendRun {
    return { backend, status: "ok", digest, stateSize: 32, calleeDigest, calleeStateSize: 24, steps: [step(0, "0100", digest)], compileMs: 0, executeMs: 0 };
}

function step(index: number, out: string, digest: string, extra: Partial<StepRecord> = {}): StepRecord {
    return { index, kind: "procedure", entry: 1, out, digest, logs: [], ...extra };
}

const DIGEST_A = "aa".repeat(32);
const DIGEST_B = "bb".repeat(32);

describe("solidity-port comparator controls", () => {
    test("agrees when the two runs are identical", () => {
        const steps = [step(0, "0100", DIGEST_A), step(1, "0200", DIGEST_A)];
        expect(compareRuns(run("typescript", steps, DIGEST_A), run("clang", steps, DIGEST_A))).toBeNull();
    });

    test("reports a step-count difference", () => {
        const left = run("typescript", [step(0, "0100", DIGEST_A), step(1, "0200", DIGEST_A)], DIGEST_A);
        const right = run("clang", [step(0, "0100", DIGEST_A)], DIGEST_A);
        expect(compareRuns(left, right)).toBe("step count 2 != 1");
    });

    test("reports an output difference and names the differing byte", () => {
        const left = run("typescript", [step(0, "01020304", DIGEST_A)], DIGEST_A);
        const right = run("clang", [step(0, "01020904", DIGEST_A)], DIGEST_A);
        expect(compareRuns(left, right)).toBe("step 0 (procedure 1): output differs at byte 2: 03 != 09");
    });

    test("reports a per-step digest difference before the final one", () => {
        const left = run("typescript", [step(0, "0100", DIGEST_A), step(1, "0200", DIGEST_A)], DIGEST_A);
        const right = run("clang", [step(0, "0100", DIGEST_B), step(1, "0200", DIGEST_A)], DIGEST_A);
        expect(compareRuns(left, right)).toContain("step 0 (procedure 1): state digest differs");
    });

    // The control that matters most: if the final digest were computed, logged, and never actually
    // compared, every other assertion here would still pass and the whole sweep would be worthless.
    test("reports a digest difference even when every step agrees", () => {
        const steps = [step(0, "0100", DIGEST_A)];
        const left = run("typescript", steps, DIGEST_A);
        const right = run("clang", steps, DIGEST_B);
        expect(compareRuns(left, right)).toBe(`final state digest differs — ts ${DIGEST_A} / clang ${DIGEST_B}`);
        expect(classify(left, right, compareRuns(left, right))).toBe("digest-mismatch");
    });

    test("reports a fault on one side only", () => {
        const left = run("typescript", [step(0, "0100", DIGEST_A)], DIGEST_A);
        const right = run("clang", [step(0, "0100", DIGEST_A, { fault: "wasm trap" })], DIGEST_A);
        expect(compareRuns(left, right)).toContain("fault differs");
        expect(classify(left, right, compareRuns(left, right))).toBe("trap-divergence");
    });

    test("reports a log difference", () => {
        const left = run("typescript", [step(0, "0100", DIGEST_A, { logs: ["1:aabb"] })], DIGEST_A);
        const right = run("clang", [step(0, "0100", DIGEST_A, { logs: [] })], DIGEST_A);
        expect(compareRuns(left, right)).toBe("step 0: log count 1 != 0");
    });

    test("reports a state-size difference", () => {
        const steps = [step(0, "0100", DIGEST_A)];
        expect(compareRuns(run("typescript", steps, DIGEST_A, 32), run("clang", steps, DIGEST_A, 40))).toBe("state size 32 != 40");
    });

    // Cross-contract writes land in the callee, so a pair whose caller state agrees can still be a
    // divergence. Comparing only the caller's digest would report a false match on every such row.
    test("reports a callee digest difference when the caller's own state agrees", () => {
        const left = pairRun("typescript", DIGEST_A, DIGEST_A);
        const right = pairRun("clang", DIGEST_A, DIGEST_B);
        expect(compareRuns(left, right)).toBe(`callee state digest differs — ts ${DIGEST_A} / clang ${DIGEST_B}`);
        expect(classify(left, right, compareRuns(left, right))).toBe("digest-mismatch");
    });

    test("reports a callee state-size difference", () => {
        const left = pairRun("typescript", DIGEST_A, DIGEST_A);
        const right: BackendRun = { ...pairRun("clang", DIGEST_A, DIGEST_A), calleeStateSize: 40 };
        expect(compareRuns(left, right)).toBe("callee state size 24 != 40");
    });

    test("agrees when both halves of a pair agree", () => {
        expect(compareRuns(pairRun("typescript", DIGEST_A, DIGEST_B), pairRun("clang", DIGEST_A, DIGEST_B))).toBeNull();
    });

    test("classifies a one-sided rejection rather than calling it a state bug", () => {
        const accepted = run("typescript", [step(0, "0100", DIGEST_A)], DIGEST_A);
        const refused: BackendRun = { backend: "clang", status: "rejected", steps: [], diagnostics: ["nope"], compileMs: 0, executeMs: 0 };
        expect(classify(accepted, refused, null)).toBe("one-side-rejected");
    });
});

describe("solidity-port corpus integrity", () => {
    test("every generated contract has a unique id and a Solidity provenance", () => {
        const variants = expandAll("full");
        expect(variants.length).toBeGreaterThan(100);
        const ids = new Set(variants.map((variant) => variant.id));
        expect(ids.size).toBe(variants.length);
        for (const variant of variants) {
            expect(variant.archetype.solidity.length).toBeGreaterThan(0);
            expect(variant.contract.script.steps.length).toBeGreaterThan(0);
            // A script that never invokes anything would match trivially and forever.
            expect(variant.contract.script.steps.some((s) => s.kind === "procedure" || s.kind === "function")).toBe(true);
        }
    });

    // clang static_asserts the DAG ordering inside the CALL macro while the TypeScript backend does not
    // check it at compile time, so a wrong-order pair would show up as a compile divergence that says
    // nothing about code generation. The generator must never emit one.
    test("every callee sits at a strictly lower slot than its caller", () => {
        const pairs = expandAll("full").filter((variant) => variant.contract.callee !== undefined);
        expect(pairs.length).toBeGreaterThan(0);
        for (const variant of pairs) {
            expect(variant.contract.callee!.slot).toBeLessThan(variant.contract.script.slot);
        }
    });
});

const wasi = wasiToolchain();

describe.skipIf(!HAS_CORE)("solidity-port live slice", () => {
    beforeAll(async () => {
        await initK12();
    });

    // The same backend twice must produce the same digest. Without this, unpinned tick or clock state
    // would manufacture "findings" out of nothing and every mismatch below would be suspect.
    test("the same artifact executed twice yields the same digest", async () => {
        const variant = expandAll("smoke").find((candidate) => candidate.archetype.name === "PromoteAdd")!;
        const env = environmentFor({ corePath: CORE_PATH, cacheDir: "work/cache" });
        const compiled = await compileWith(env, "typescript", {
            main: { name: variant.archetype.name, source: variant.contract.source, slot: variant.contract.script.slot },
        });
        expect(compiled.main.ok).toBe(true);
        const first = executeScript("typescript", compiled.main.wasm!, variant.contract.script);
        const second = executeScript("typescript", compiled.main.wasm!, variant.contract.script);
        expect(first.digest).toBe(second.digest!);
        expect(first.digest).toBeDefined();
    }, 120_000);

    toolchainTest(
        "a slice of the corpus agrees across both backends",
        wasi,
        async () => {
            const env = environmentFor({ corePath: CORE_PATH, cacheDir: "work/cache" });
            // One contract per family, so a codegen regression in any area turns this red.
            const seen = new Set<string>();
            const slice = expandAll("smoke").filter((variant) => {
                if (seen.has(variant.archetype.family)) return false;
                seen.add(variant.archetype.family);
                return true;
            });
            expect(slice.length).toBeGreaterThanOrEqual(5);

            // Archetypes that exist to carry an open finding: they are supposed to diverge, and a green
            // row for one of them would mean the defect had been fixed (or the harness had gone blind).
            // Anything else diverging is new and fails the control.
            const knownDivergences = new Set(["DivQpi", "NsInheritedNamespacedTypedef", "K12OfComputedExpression", "ShiftRhsWiderThanLhs"]);

            const failures: string[] = [];
            for (const variant of slice) {
                const result = await runCell(env, {
                    id: variant.id,
                    archetype: variant.archetype.name,
                    family: variant.archetype.family,
                    axis: variant.axis,
                    contractName: variant.archetype.name,
                    source: variant.contract.source,
                    script: variant.contract.script,
                    callee: variant.contract.callee,
                    expectReject: variant.archetype.expectReject,
                    expectedVerdict: variant.archetype.expectedVerdict,
                    divergenceNote: variant.archetype.divergenceNote,
                });
                if (result.verdict !== "match" && !knownDivergences.has(result.archetype)) {
                    failures.push(`${result.id}: ${result.verdict} ${result.firstDifference ?? ""}`);
                }
            }
            expect(failures).toEqual([]);
        },
        600_000,
    );
});
