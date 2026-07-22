// Run real core-lite system-contract gtests with a WASI-Clang-compiled test harness and TS-compiled
// contract Wasm. The routine default is the light tier; heavy state/dispatch suites are explicit.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { wasiSdkPaths } from "@qinit/core/project";
import { runCorpus, systemGtestCorpora, type SystemGtestTier } from "../packages/cli/src/corpus-run";

type Selection = SystemGtestTier | "all";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function selection(): Selection {
  const selected = (["light", "heavy", "all"] as const).filter((name) =>
    process.argv.includes(`--${name}`),
  );
  if (selected.length > 1) {
    throw new Error("choose only one of --light, --heavy, or --all");
  }
  return selected[0] ?? "light";
}

const tier = selection();
const coreArg = option("--core") ?? process.env.QINIT_CORE;
if (!coreArg) {
  throw new Error("QINIT_CORE is required (or pass --core <core-lite checkout>)");
}
const core = resolve(coreArg);
if (!existsSync(join(core, "src", "contract_core", "contract_def.h"))) {
  throw new Error(`${core} is not a core-lite checkout`);
}

const filter = new Set(
  (option("--filter") ?? "")
    .split(",")
    .map((name) => name.trim().toUpperCase())
    .filter(Boolean),
);
const discovered = systemGtestCorpora(core);
const selected = discovered.filter((entry) =>
  (tier === "all" || entry.tier === tier) &&
  (!filter.size || filter.has(entry.name.toUpperCase())),
);

if (process.argv.includes("--list")) {
  for (const entry of discovered) {
    console.log(`${entry.tier.padEnd(5)} ${entry.name.padEnd(12)} ${entry.corpusPath}`);
  }
  process.exit(0);
}
if (!selected.length) {
  throw new Error(
    `no ${tier} system gtest corpora matched${filter.size ? `: ${[...filter].join(", ")}` : ""}`,
  );
}

const sdk = wasiSdkPaths();
if (!sdk) {
  throw new Error("WASI SDK clang/sysroot not found; the real gtest harness requires Clang");
}

console.log(`system gtests: ${tier} · ${selected.length}/${discovered.length} corpora`);
console.log("runner: WASI Clang · contracts: TS compiler · host: Qinit engine\n");

interface Row {
  name: string;
  tier: SystemGtestTier;
  passed: number;
  total: number;
  seconds: number;
  error?: string;
}

const rows: Row[] = [];
for (const [index, entry] of selected.entries()) {
  const scratch = mkdtempSync(join(tmpdir(), `qinit-system-gtest-${entry.name.toLowerCase()}-`));
  const started = performance.now();
  let phase = "starting";
  console.log(`[${index + 1}/${selected.length}] ${entry.name} (${entry.tier})`);
  try {
    const run = await runCorpus({
      name: entry.name,
      core,
      backend: "local",
      scratch,
      onPhase: (label) => {
        phase = label;
      },
    });
    const passed = run.results.filter((result) => result.passed).length;
    const failed = run.results.filter((result) => !result.passed);
    let error: string | undefined;
    if (!run.runnerOk) {
      error = run.buildError ?? "Clang runner build failed";
    } else if (run.results.length === 0) {
      error = "gtest corpus produced no results";
    } else if (failed.length) {
      error = failed
        .map(
          (result) =>
            `${result.name}: ${result.message.replace(/\s+/g, " ").slice(0, 180)}`,
        )
        .join(" | ");
    }
    rows.push({
      name: entry.name,
      tier: entry.tier,
      passed,
      total: run.results.length,
      seconds: (performance.now() - started) / 1000,
      error,
    });
    console.log(
      `  ${error ? "FAIL" : "PASS"} ${passed}/${run.results.length}${error ? ` · ${error}` : ""}\n`,
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    rows.push({
      name: entry.name,
      tier: entry.tier,
      passed: 0,
      total: 0,
      seconds: (performance.now() - started) / 1000,
      error: `${phase}: ${message}`,
    });
    console.log(`  FAIL ${phase}: ${message}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const width = Math.max(8, ...rows.map((row) => row.name.length));
console.log(`${"CONTRACT".padEnd(width)}  TIER   TESTS    TIME    RESULT`);
console.log("-".repeat(width + 34));
for (const row of rows) {
  const tests = `${row.passed}/${row.total}`.padEnd(7);
  const elapsed = `${row.seconds.toFixed(1)}s`.padEnd(7);
  console.log(
    `${row.name.padEnd(width)}  ${row.tier.padEnd(5)}  ${tests}  ${elapsed} ${row.error ? "FAIL" : "PASS"}`,
  );
}
const passedSuites = rows.filter((row) => !row.error).length;
const passedTests = rows.reduce((sum, row) => sum + row.passed, 0);
const totalTests = rows.reduce((sum, row) => sum + row.total, 0);
console.log(
  `\n${passedSuites}/${rows.length} contracts passed · ${passedTests}/${totalTests} tests passed`,
);
if (passedSuites !== rows.length) {
  process.exitCode = 1;
}
