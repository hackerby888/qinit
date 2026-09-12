// A quick fix that produces code the compiler rejects is worse than no quick fix at all: the developer
// accepted it on the extension's authority and their file is now broken in a way they did not type.
//
// So this applies every fix the analyzer offers and asks the compiler what it thinks of the result:
//
//   cleared    — the diagnostic the fix was attached to is gone from the fixed source
//   no regress — no diagnostic code appeared that was not there before
//   builds     — clang accepts the fixed source (the only authority that matters)
//
// A fix is only correct when all three hold. Sources that clang already refused before the fix are
// reported separately, because there the fix cannot be blamed for a build that was broken anyway.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { analyzeContract, type SourceAnalysisDiagnostic, type SourceFix } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";
import { FIX_PROBES } from "./fix-probes";

const SLOT = 31;
const NAME = "FixProbe";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required: the clang oracle needs a core-lite checkout");
    process.exit(2);
}
await initK12();
const headers = loadQpiHeader(CORE_PATH);

const analyze = (source: string): SourceAnalysisDiagnostic[] => {
    try {
        return analyzeContract({ source, contractName: NAME, slot: SLOT, qpiHeader: headers }).diagnostics;
    } catch (cause) {
        return [{ code: `THREW:${cause instanceof Error ? cause.message.slice(0, 50) : ""}` } as SourceAnalysisDiagnostic];
    }
};

/** Applies a fix the way `QpiCodeActions` does — last edit first, so earlier offsets stay valid. */
function applyFix(source: string, fix: SourceFix): string {
    const edits = [...fix.edits].sort((a, b) => b.span.start - a.span.start);
    let out = source;
    for (const edit of edits) out = out.slice(0, edit.span.start) + edit.newText + out.slice(edit.span.end);
    return out;
}

async function clangAccepts(source: string): Promise<{ ok: boolean; detail: string }> {
    const directory = mkdtempSync(join(tmpdir(), "fix-diff-"));
    try {
        writeFileSync(join(directory, `${NAME}.h`), source);
        const built = await buildContractWithClang({
            contractPath: join(directory, `${NAME}.h`),
            contractName: NAME,
            slot: SLOT,
            corePath: CORE_PATH,
            outDir: directory,
            skipVerify: true,
        });
        const detail = built.ok
            ? ""
            : String(built.stderr ?? "")
                  .split("\n")
                  .filter((line) => / error:|Qubic protocol|violation/.test(line))
                  .slice(0, 1)
                  .join(" ")
                  .replace(/^.*FixProbe\.h/, "FixProbe.h")
                  .slice(0, 110);
        return { ok: built.ok, detail };
    } catch (cause) {
        return { ok: false, detail: cause instanceof Error ? cause.message.slice(0, 110) : String(cause) };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const selected = only.length ? FIX_PROBES.filter((p) => only.some((o) => p.name.includes(o))) : FIX_PROBES;

console.log(`quick-fix differential: ${selected.length} probes · core ${CORE_PATH}\n`);

let offered = 0;
const broken: string[] = [];
const uncleared: string[] = [];
const regressed: string[] = [];
const missing: string[] = [];
const offeredWhenItShouldNot: string[] = [];

for (const probe of selected) {
    const before = analyze(probe.source);
    const beforeCodes = new Set(before.map((d) => d.code));
    const countOf = (list: SourceAnalysisDiagnostic[], code: string) => list.filter((d) => d.code === code).length;
    const withFixes = before.filter((d) => d.fixes?.length);

    if (!withFixes.length) {
        const declined = probe.expectNoFix ? " (correctly declined)" : "";
        console.log(`${probe.name.padEnd(42)} no fix offered for [${[...beforeCodes].join(",") || "nothing"}]${declined}`);
        if (probe.expectFix) missing.push(`${probe.name}: expected a fix for ${probe.expectFix}, none offered`);
        continue;
    }
    if (probe.expectNoFix) {
        offeredWhenItShouldNot.push(`${probe.name}: a fix was offered for ${probe.expectNoFix}, which cannot compile`);
    }

    const buildsBefore = await clangAccepts(probe.source);
    for (const diagnostic of withFixes) {
        for (const fix of diagnostic.fixes!) {
            offered++;
            const fixed = applyFix(probe.source, fix);
            const after = analyze(fixed);
            const afterCodes = new Set(after.map((d) => d.code));
            // Fewer of this code than before: the occurrence the fix targeted is gone. Requiring the code
            // to vanish entirely would fail a line that carries two of them.
            const cleared = countOf(after, diagnostic.code) < countOf(before, diagnostic.code);
            const added = [...afterCodes].filter((code) => !beforeCodes.has(code));
            const buildsAfter = await clangAccepts(fixed);

            const verdicts = [
                cleared ? "cleared" : "NOT-CLEARED",
                added.length ? `ADDED:${added.join("/")}` : "no-regress",
                buildsAfter.ok ? "builds" : buildsBefore.ok ? "BREAKS-BUILD" : "still-broken",
            ];
            const bad = verdicts.some((v) => v === v.toUpperCase() && v !== "builds");
            console.log(`${probe.name.padEnd(42)} ${diagnostic.code.padEnd(24)} "${fix.title}"`);
            console.log(`${" ".repeat(42)}   ${verdicts.join(" · ")}${bad ? "   <<<" : ""}`);
            if (!buildsAfter.ok && buildsBefore.ok) {
                console.log(`${" ".repeat(42)}   clang: ${buildsAfter.detail}`);
                console.log(`${" ".repeat(42)}   result: ${fixed.split("\n").find((l) => l.includes("Array<") || l.includes("QPI::")) ?? "(see source)"}`);
                broken.push(`${probe.name} · ${fix.title} -> ${buildsAfter.detail}`);
            }
            if (!cleared) uncleared.push(`${probe.name} · ${fix.title} left ${diagnostic.code} in place`);
            if (added.length) regressed.push(`${probe.name} · ${fix.title} introduced ${added.join(", ")}`);
        }
    }
}

const report = (label: string, rows: string[]) => {
    if (!rows.length) return;
    console.log(`\n=== ${label} ===`);
    for (const row of rows) console.log(`  ${row}`);
};
report("fixes that break the build", broken);
report("fixes that do not clear their own diagnostic", uncleared);
report("fixes that introduce a new diagnostic", regressed);
report("diagnostics that offered no fix", missing);
report("fixes offered where none can compile", offeredWhenItShouldNot);

console.log(
    `\n${offered} fixes applied · ${broken.length} break the build · ${uncleared.length} not cleared · ` +
        `${regressed.length} regressed · ${missing.length} missing · ${offeredWhenItShouldNot.length} wrongly offered`,
);
process.exitCode = broken.length + uncleared.length + regressed.length + missing.length + offeredWhenItShouldNot.length ? 1 : 0;
