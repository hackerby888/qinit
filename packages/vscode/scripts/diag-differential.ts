// What the editor squiggles versus what the build does, on the same source. Three oracles: `qpi/*` policy
// rules name the code they must produce, clang judges everything semantic, and controls must stay silent.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { analyzeContract, DiagnosticSeverity } from "@qinit/compiler/analyzer";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";
import { PROBES, type Probe } from "./diag-probes";

const SLOT = 31;
const NAME = "DiffProbe";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required: the clang oracle needs a core-lite checkout");
    process.exit(2);
}
// The compile pipeline hashes through K12; without this the backend returns no diagnostics at all
// rather than failing loudly, which reads as "everything agrees".
await initK12();
const headers = loadQpiHeader(CORE_PATH);

// Diagnostics raised while lowering a function body carry a message and no code at all, so keying on
// `code` alone renders a real error as silence — the blind spot this whole script exists to find.
const labelOf = (d: { code?: string; message?: string }) => d.code ?? `(uncoded) ${String(d.message ?? "").slice(0, 48)}`;

interface Reading {
    codes: string[];
    errors: string[];
}

/** What the editor would draw: analyzeContract is the call behind every `qpi`/`qinit-compiler` squiggle. */
function editorReading(source: string): Reading {
    try {
        const result = analyzeContract({ source, contractName: NAME, slot: SLOT, qpiHeader: headers });
        return {
            codes: result.diagnostics.map(labelOf),
            errors: result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR).map(labelOf),
        };
    } catch (cause) {
        const threw = `THREW:${cause instanceof Error ? cause.message.slice(0, 60) : String(cause)}`;
        return { codes: [threw], errors: [threw] };
    }
}

async function backendErrors(source: string): Promise<string[]> {
    try {
        const built = await compileContractWithTypeScript({ source, contractName: NAME, slot: SLOT, qpiHeader: headers, arenaSizeBytes: 1 << 20 });
        return built.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR).map(labelOf);
    } catch (cause) {
        return [`THREW:${cause instanceof Error ? cause.message.slice(0, 60) : String(cause)}`];
    }
}

/** The oracle. skipVerify keeps this to "does clang accept this source", which is the question asked. */
async function clangAccepts(source: string): Promise<{ ok: boolean; detail: string }> {
    const directory = mkdtempSync(join(tmpdir(), "diag-diff-"));
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
            : String(built.stderr ?? built.error ?? "")
                  .split("\n")
                  .filter(Boolean)
                  .slice(0, 2)
                  .join(" ")
                  .slice(0, 140);
        return { ok: built.ok, detail };
    } catch (cause) {
        return { ok: false, detail: cause instanceof Error ? cause.message.slice(0, 140) : String(cause) };
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

type Verdict = "ok" | "MISSING-RULE" | "GAP" | "SPURIOUS" | "CONTROL-REFUSED" | "RULE-NOT-REFUSAL" | "NO-ORACLE";

function verdictOf(probe: Probe, editor: Reading, clangOk: boolean): Verdict {
    if (probe.code) {
        // A policy rule: the code must appear, at whatever severity the rule chose.
        return editor.codes.includes(probe.code) ? "ok" : "MISSING-RULE";
    }
    if (probe.wantsWarning) {
        // Nothing refuses this, so there is no oracle to appeal to: the editor is the only thing that
        // could tell the developer, and saying nothing is the finding.
        return editor.codes.length > 0 ? "ok" : "NO-ORACLE";
    }
    if (probe.refused) {
        // clang is expected to refuse. If it builds instead, the probe is wrong, not the editor.
        if (clangOk) return "RULE-NOT-REFUSAL";
        return editor.errors.length > 0 ? "ok" : "GAP";
    }
    // A control: it must build, and the editor must be silent.
    if (!clangOk) return "CONTROL-REFUSED";
    return editor.codes.length === 0 ? "ok" : "SPURIOUS";
}

// A stray comma in the corpus leaves an array hole, and `filter`/`map` skip holes rather than reporting
// them — so a corpus that silently lost probes looks like a corpus that passed. Fail loudly instead.
const holes = [...Array(PROBES.length).keys()].filter((index) => !(index in PROBES));
if (holes.length) {
    console.error(`diag-probes has ${holes.length} array hole(s) at index ${holes.join(", ")} — a stray comma between entries`);
    process.exit(2);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const selected = only.length ? PROBES.filter((p) => only.some((o) => p.name.includes(o))) : PROBES;

console.log(`diagnostics differential: ${selected.length} probes · core ${CORE_PATH}\n`);
console.log(`${"PROBE".padEnd(44)} ${"CLANG".padEnd(8)} ${"EDITOR".padEnd(26)} VERDICT`);
console.log("-".repeat(104));

const rows: Array<{ probe: Probe; editor: Reading; backend: string[]; clangOk: boolean; detail: string; verdict: Verdict }> = [];
for (const probe of selected) {
    const editor = editorReading(probe.source);
    const backend = await backendErrors(probe.source);
    const { ok: clangOk, detail } = await clangAccepts(probe.source);
    const verdict = verdictOf(probe, editor, clangOk);
    rows.push({ probe, editor, backend, clangOk, detail, verdict });
    const shown = editor.codes.length ? [...new Set(editor.codes)].join(",").slice(0, 25) : "(silent)";
    console.log(`${probe.name.padEnd(44)} ${(clangOk ? "builds" : "refuses").padEnd(8)} ${shown.padEnd(26)} ${verdict === "ok" ? "ok" : `<<< ${verdict}`}`);
}

const bad = rows.filter((r) => r.verdict !== "ok");
if (bad.length) {
    console.log("\n=== disagreements ===");
    for (const row of bad) {
        console.log(`\n${row.verdict}: ${row.probe.name}`);
        console.log(`  expected: ${row.probe.expect}`);
        if (row.probe.wantsWarning) console.log(`  at stake: ${row.probe.wantsWarning}`);
        console.log(`  clang:    ${row.clangOk ? "accepts" : `refuses — ${row.detail}`}`);
        console.log(`  editor:   ${row.editor.codes.length ? [...new Set(row.editor.codes)].join(", ") : "(silent)"}`);
        console.log(`  backend:  ${row.backend.length ? [...new Set(row.backend)].join(", ") : "(silent)"}`);
    }
}

const count = (v: Verdict) => bad.filter((r) => r.verdict === v).length;
console.log(
    `\n${rows.length - bad.length}/${rows.length} agree · ${count("GAP")} GAP · ${count("MISSING-RULE")} MISSING-RULE · ` +
        `${count("SPURIOUS")} SPURIOUS · ${count("CONTROL-REFUSED")} CONTROL-REFUSED · ${count("RULE-NOT-REFUSAL")} RULE-NOT-REFUSAL · ` +
        `${count("NO-ORACLE")} NO-ORACLE`,
);
process.exitCode = bad.length ? 1 : 0;
