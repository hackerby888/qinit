// Write the corpus: one .h per contract, one call script per family, and a manifest.
//
//   bun run scripts/solidity-port/generate.ts                 regenerate corpus/solidity-port/
//   bun run scripts/solidity-port/generate.ts --check         fail if the tree differs from the generator
//   bun run scripts/solidity-port/generate.ts --analyze-only  run the shared build gate over every variant
//
// The corpus is generator-owned and not committed, so CI regenerates it before every sweep and drift
// cannot happen. `--check` stays useful locally, to catch a variant edited by hand during triage.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeContract } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { DiagnosticSeverity } from "@qinit/compiler/shared/enums";
import { canonicalAxis, expandAll, GENERATOR_VERSION, TIERS, type Tier, type Variant } from "./registry";
import { CORPUS_SLOT } from "./archetypes/common";

const ROOT = "corpus/solidity-port";

interface ManifestRow {
    id: string;
    archetype: string;
    family: string;
    axis: string;
    solidity: string;
    fidelity: "shape-only" | "faithful";
    expectReject: boolean;
    file: string;
    sourceSha256: string;
    scriptSha256: string;
    generatorVersion: number;
}

function sha256(value: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(value);
    return hasher.digest("hex");
}

/**
 * A port is "faithful" only when nothing about it had to change to fit QPI. Anything carrying a caveat —
 * a width reduction, a bounded container, a guard standing in for a revert — is shape-only, and the
 * report prints the mix so nobody reads the corpus as a claim about Solidity conformance.
 */
function fidelityOf(variant: Variant): "shape-only" | "faithful" {
    return variant.archetype.caveat ? "shape-only" : "faithful";
}

function buildFiles(tier: Tier): { files: Map<string, string>; manifest: ManifestRow[] } {
    const variants = expandAll(tier);
    const files = new Map<string, string>();
    const scriptsByFamily = new Map<string, string[]>();
    const manifest: ManifestRow[] = [];

    for (const variant of variants) {
        const name = `${variant.archetype.name}__${variant.variantId}`;
        const file = `variants/${variant.archetype.family}/${name}.h`;
        files.set(file, variant.contract.source);

        const scriptLine = JSON.stringify({ contract: name, ...variant.contract.script });
        const lines = scriptsByFamily.get(variant.archetype.family) ?? [];
        lines.push(scriptLine);
        scriptsByFamily.set(variant.archetype.family, lines);

        manifest.push({
            id: variant.id,
            archetype: variant.archetype.name,
            family: variant.archetype.family,
            axis: canonicalAxis(variant.axis) || "base",
            solidity: variant.archetype.solidity,
            fidelity: fidelityOf(variant),
            expectReject: variant.archetype.expectReject === true,
            file,
            sourceSha256: sha256(variant.contract.source),
            scriptSha256: sha256(scriptLine),
            generatorVersion: GENERATOR_VERSION,
        });
    }

    for (const [family, lines] of scriptsByFamily) files.set(`scripts/${family}.jsonl`, `${lines.join("\n")}\n`);
    files.set("manifest.jsonl", `${manifest.map((row) => JSON.stringify(row)).join("\n")}\n`);
    files.set("README.md", readme(tier, manifest));
    return { files, manifest };
}

function readme(tier: Tier, manifest: ManifestRow[]): string {
    const families = new Map<string, number>();
    for (const row of manifest) families.set(row.family, (families.get(row.family) ?? 0) + 1);
    const archetypes = new Set(manifest.map((row) => row.archetype)).size;
    const faithful = manifest.filter((row) => row.fidelity === "faithful").length;

    return [
        "# Solidity-port differential corpus",
        "",
        "Generated, and not committed — edit the archetype in `scripts/solidity-port/archetypes/` and",
        "regenerate. See `scripts/solidity-port/README.md` for how to run a sweep.",
        "",
        `Tier \`${tier}\` · ${archetypes} archetypes · ${manifest.length} contracts · generator version ${GENERATOR_VERSION}.`,
        "",
        "| family | contracts |",
        "| --- | ---: |",
        ...[...families].sort(([a], [b]) => a.localeCompare(b)).map(([family, count]) => `| ${family} | ${count} |`),
        "",
        "## What this is",
        "",
        "Each contract is a Qubic QPI port of a tricky Solidity pattern, taken from",
        "`ethereum/solidity`'s `test/libsolidity/semanticTests`, `crytic/not-so-smart-contracts` and",
        "OpenZeppelin. Every file's header comment names its Solidity origin, what it stresses in the",
        "compiler, and how the port differs from the original.",
        "",
        "The corpus exists to be compiled by **both** Qinit backends — the TypeScript compiler and clang —",
        "and executed on a byte-identical call script, so their final-state K12 digests can be compared.",
        "",
        "```sh",
        "export QINIT_CORE=/path/to/core-lite",
        "export WASM_CLANG=/path/to/wasi-sdk/bin/clang++ WASI_SYSROOT=/path/to/wasi-sdk/share/wasi-sysroot",
        "bun run scripts/solidity-port/run-differential.ts --tier full --workers 3",
        "```",
        "",
        "## What it is not",
        "",
        `Only ${faithful} of ${manifest.length} contracts are faithful ports; the rest are marked \`shape-only\` in`,
        "`manifest.jsonl`. QPI has no revert, no `uint256`, no unbounded mapping and no reentrancy, so a",
        "Solidity test whose point was atomicity or 256-bit wraparound becomes a *different* test after",
        "porting. The corpus is a source of adversarial **shapes**, not evidence about Solidity semantics.",
        "",
        "Nor is it a set of independent trials: the contracts are variants of a much smaller number of",
        "archetypes, so the effective sample size is closer to the archetype count than the contract count.",
        "The variants earn their place as an axis bisector during triage — when a mismatch appears, the",
        "sibling variants that differ in exactly one axis name the trigger.",
        "",
    ].join("\n");
}

function listExisting(root: string): Map<string, string> {
    const found = new Map<string, string>();
    const walk = (directory: string, prefix: string): void => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (entry.name === "triage" || entry.name === ".results") continue;
                walk(join(directory, entry.name), relative);
            } else {
                found.set(relative, readFileSync(join(directory, entry.name), "utf8"));
            }
        }
    };
    walk(root, "");
    return found;
}

async function analyzeAll(tier: Tier, only?: RegExp): Promise<number> {
    const corePath = process.env.QINIT_CORE;
    if (!corePath) throw new Error("QINIT_CORE must point at a core-lite checkout to analyze the corpus");
    const qpiHeader = loadQpiHeader(corePath);
    const variants = expandAll(tier).filter((variant) => !only || only.test(variant.archetype.name));
    let errors = 0;
    let expectedRejections = 0;

    for (const variant of variants) {
        const analysis = analyzeContract({
            source: variant.contract.source,
            contractName: variant.archetype.name,
            slot: CORPUS_SLOT,
            qpiHeader,
        });
        const failures = analysis.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
        // An archetype that documents a divergence may be one the TypeScript front end refuses on
        // purpose (F209 is exactly that), so its diagnostics are the point rather than a failure.
        if (variant.archetype.expectReject || variant.archetype.expectedVerdict) {
            expectedRejections++;
            continue;
        }
        if (failures.length) {
            errors++;
            console.log(`ERROR ${variant.id}`);
            for (const failure of failures.slice(0, 3)) console.log(`      ${failure.message}`);
        }
    }
    console.log(`${variants.length} variants analyzed · ${errors} with ERROR diagnostics · ${expectedRejections} expected-reject or documented-divergence (not analyzed)`);
    return errors;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const tierArgument = argv.indexOf("--tier");
    const tier = (tierArgument >= 0 ? argv[tierArgument + 1] : "full") as Tier;
    if (!(tier in TIERS)) throw new Error(`--tier must be one of ${Object.keys(TIERS).join(", ")}`);

    if (argv.includes("--analyze-only")) {
        // `--only <pattern>` narrows the gate to the archetypes whose name matches, which is what makes
        // authoring a new batch a seconds-long loop rather than a full-corpus one.
        const onlyArgument = argv.indexOf("--only");
        const only = onlyArgument >= 0 ? new RegExp(argv[onlyArgument + 1]) : undefined;
        process.exit((await analyzeAll(tier, only)) === 0 ? 0 : 1);
    }

    const { files, manifest } = buildFiles(tier);

    if (argv.includes("--check")) {
        const existing = listExisting(ROOT);
        const drift: string[] = [];
        for (const [path, content] of files) {
            if (existing.get(path) !== content) drift.push(existing.has(path) ? `changed: ${path}` : `missing: ${path}`);
        }
        for (const path of existing.keys()) if (!files.has(path)) drift.push(`stale: ${path}`);
        if (drift.length) {
            console.log(`corpus is out of date with its generator (${drift.length} file(s)):`);
            for (const line of drift.slice(0, 25)) console.log(`  ${line}`);
            if (drift.length > 25) console.log(`  … ${drift.length - 25} more`);
            console.log("run: bun run scripts/solidity-port/generate.ts");
            process.exit(1);
        }
        console.log(`corpus matches the generator: ${files.size} files, ${manifest.length} contracts`);
        return;
    }

    for (const directory of ["variants", "scripts"]) rmSync(join(ROOT, directory), { recursive: true, force: true });
    for (const [path, content] of files) {
        const full = join(ROOT, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content);
    }
    console.log(`wrote ${files.size} files · ${manifest.length} contracts · tier ${tier} · generator version ${GENERATOR_VERSION}`);
}

await main();
