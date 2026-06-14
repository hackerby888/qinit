// clangd enablement gate — proves the generated compile DB makes clangd fully resolve a qpi.h contract
// (ZERO C++ errors) WITHOUT the author including qpi.h. Runs over the qinit fixtures AND the real
// deployed core contracts (QX/QEARN/QUtil/Random — HashMap, inter-contract, lifecycle, proposals), so
// IntelliSense is proven on real-world complexity, not just toy fixtures.
//
//   QINIT_CORE=/path/to/core-lite bun run packages/vscode/scripts/clangd-gate.ts [Name ...]
// Needs `clangd` on PATH (or $CLANGD) — ideally the same major version as the wasi-sdk clang. wasi from
// the synced cache (local `qinit up`) or WASM_CLANG/WASI_SYSROOT env (CI).
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCore, wasiSdkPaths } from "@qinit/core/project";
import { generateClangdConfig } from "../src/clangd-config";

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

console.log(`core:       ${core}`);
console.log(`wasi clang: ${wasiClang}`);
console.log(`clangd:     ${CLANGD}`);
console.log(`contracts:  ${entries.map((e) => e.name).join(", ")}\n`);

const INTERESTING = /error:|fatal error:|file not found|use of undeclared|no member named|unknown type name|no template named/i;

let failures = 0;
for (const { name, path: contractPath } of entries) {
  const ws = mkdtempSync(join(tmpdir(), "qpi-gate-"));
  try {
    const cfg = generateClangdConfig({ contractPath, corePath: core, wasiClang, wasiSysroot, workspaceRoot: ws, name });
    const p = Bun.spawnSync(
      [CLANGD, `--check=${cfg.contractFile}`, `--compile-commands-dir=${cfg.dir}`, `--query-driver=${wasiClang}`, "--log=error"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const log = (p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? "");
    const errorLines = log.split("\n").filter((l) => /error:|fatal error:/.test(l));
    const ok = errorLines.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(10)} (${errorLines.length} error lines)`);
    if (!ok) {
      failures++;
      const shown = log.split("\n").filter((l) => INTERESTING.test(l)).slice(0, 30);
      console.log(shown.map((l) => "      " + l.trim()).join("\n") || "      (no diagnostic lines captured — check clangd output / exit)");
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? `GATE: PASS — clangd resolves all ${entries.length} contracts` : `GATE: FAIL (${failures}/${entries.length})`}`);
process.exit(failures === 0 ? 0 : 1);
