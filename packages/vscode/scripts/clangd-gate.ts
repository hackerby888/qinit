// clangd enablement gate — proves the generated compile DB makes clangd fully resolve a qpi.h contract
// (ZERO C++ errors) WITHOUT the author including qpi.h. Runs over the qinit fixtures AND the real
// deployed core contracts (QX/QEARN/QUtil/Random — HashMap, inter-contract, lifecycle, proposals), so
// IntelliSense is proven on real-world complexity, not just toy fixtures.
//
//   QINIT_CORE=/path/to/core-lite bun run packages/vscode/scripts/clangd-gate.ts [Name ...]
// Needs `clangd` on PATH (or $CLANGD) — ideally the same major version as the wasi-sdk clang. wasi from
// the synced cache (local `qinit up`) or WASM_CLANG/WASI_SYSROOT env (CI).
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCore, wasiSdkPaths } from "@qinit/core/project";
import { scanCallees, type DynCallees } from "@qinit/build/intercontract";
import { generateClangdConfig } from "../src/clangd-config";
import { clangdErrorLines } from "../src/clangd-diag";

const REPO_ROOT = resolve(import.meta.dir, "../../.."); // packages/vscode/scripts -> repo root
const CLANGD = process.env.CLANGD ?? "clangd";
const requested = process.argv.slice(2);

const core = resolveCore(process.env.QINIT_CORE);
const sdk = wasiSdkPaths();
const wasiClang = process.env.WASM_CLANG ?? sdk?.clang;
const wasiSysroot = process.env.WASI_SYSROOT ?? sdk?.sysroot;
if (!wasiClang) { console.error("no wasi-sdk — run `qinit up` (or set WASM_CLANG/WASI_SYSROOT)"); process.exit(2); }

// Real deployed contracts (core-lite/src/contracts) → varied QPI features.
const REAL: Record<string, string> = { QX: "Qx.h", QEARN: "Qearn.h", QUTIL: "QUtil.h", RANDOM: "Random.h" };

function entryFor(name: string): { name: string; path: string } | null {
  const fx = join(REPO_ROOT, "fixtures", name + ".h");
  if (existsSync(fx)) return { name, path: fx };
  const real = REAL[name.toUpperCase()];
  if (real) { const p = join(core, "src", "contracts", real); if (existsSync(p)) return { name, path: p }; }
  return null;
}

const names = requested.length ? requested : ["Counter", "Token", "Bank", "Proxy", "Logger", ...Object.keys(REAL)];
const entries = names.map(entryFor).filter((e): e is { name: string; path: string } => e !== null);

// Offline inter-contract resolution: a fixture that calls a sibling fixture (e.g. Proxy -> Counter)
// gets that sibling fed as a dyn callee — the same DynCallees the extension builds from the node's
// stored sources at runtime. In-core callees (QX's, etc.) resolve via contract_def.h, not here.
function siblingCallees(source: string): DynCallees {
  const out: DynCallees = {};
  for (const callee of scanCallees(source)) {
    const sib = join(REPO_ROOT, "fixtures", callee + ".h");
    if (existsSync(sib)) out[callee] = { header: sib, index: 1 };
  }
  return out;
}

console.log(`core:       ${core}`);
console.log(`wasi clang: ${wasiClang}`);
console.log(`clangd:     ${CLANGD}`);
console.log(`contracts:  ${entries.map((e) => e.name).join(", ")}\n`);

let failures = 0;
for (const { name, path: contractPath } of entries) {
  const ws = mkdtempSync(join(tmpdir(), "qpi-gate-"));
  try {
    const dynCallees = siblingCallees(readFileSync(contractPath, "utf8"));
    const cfg = generateClangdConfig({ contractPath, corePath: core, wasiClang, wasiSysroot, workspaceRoot: ws, name, dynCallees });
    const p = Bun.spawnSync(
      [CLANGD, `--check=${cfg.contractFile}`, `--compile-commands-dir=${cfg.dir}`, `--query-driver=${wasiClang}`, "--log=error"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const log = (p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? "");
    const errorLines = clangdErrorLines(log);
    const ok = errorLines.length === 0;
    const callees = Object.keys(dynCallees);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(10)} (${errorLines.length} errors)${callees.length ? `  [callees: ${callees.join(", ")}]` : ""}`);
    if (!ok) {
      failures++;
      const shown = [...new Set(errorLines.map((l) => l.replace(/^E\[[^\]]*\]\s*/, "").trim()))].slice(0, 30);
      console.log(shown.map((l) => "      " + l).join("\n"));
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? `GATE: PASS — clangd resolves all ${entries.length} contracts` : `GATE: FAIL (${failures}/${entries.length})`}`);
process.exit(failures === 0 ? 0 : 1);
