// M1 GATE — proves the generated clangd compile DB makes clangd fully resolve a qpi.h contract
// fragment (ZERO C++ errors) WITHOUT the author including qpi.h. This is the make-or-break check for
// the whole extension; everything else (diagnostics, hover, CodeLens) is moot until this is solid.
//
// Run locally (or in CI's corpus job, which already has core + wasi-sdk):
//   QINIT_CORE=/path/to/core-lite bun run packages/vscode/scripts/clangd-gate.ts [Fixture ...]
// Needs `clangd` on PATH (or $CLANGD) — ideally the same major version as the wasi-sdk clang.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCore, wasiSdkPaths } from "@qinit/core/project";
import { generateClangdConfig } from "../src/clangd-config";

const REPO_ROOT = resolve(import.meta.dir, "../../.."); // packages/vscode/scripts -> repo root
const CLANGD = process.env.CLANGD ?? "clangd";
const requested = process.argv.slice(2);
const fixtures = requested.length ? requested : ["Counter", "Token", "Bank", "Proxy", "Logger"];

const core = resolveCore(process.env.QINIT_CORE);
const wasi = wasiSdkPaths();
if (!wasi) { console.error("no wasi-sdk synced — run `qinit up` (or set WASM_CLANG/WASI_SYSROOT)"); process.exit(2); }

console.log(`core:       ${core}`);
console.log(`wasi clang: ${wasi.clang}`);
console.log(`clangd:     ${CLANGD}\n`);

const INTERESTING = /error:|fatal error:|file not found|use of undeclared|no member named|unknown type name|no template named/i;

let failures = 0;
for (const fx of fixtures) {
  const contractPath = join(REPO_ROOT, "fixtures", fx + ".h");
  const ws = mkdtempSync(join(tmpdir(), "qpi-gate-"));
  try {
    const cfg = generateClangdConfig({
      contractPath, corePath: core, wasiClang: wasi.clang, wasiSysroot: wasi.sysroot, workspaceRoot: ws,
    });
    const p = Bun.spawnSync(
      [CLANGD, `--check=${cfg.wrapperPath}`, `--compile-commands-dir=${cfg.dir}`, `--query-driver=${wasi.clang}`, "--log=error"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const log = (p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? "");
    const errorLines = log.split("\n").filter((l) => /error:|fatal error:/.test(l));
    const ok = errorLines.length === 0;
    console.log(`${ok ? "PASS" : "FAIL"}  ${fx.padEnd(10)} (${errorLines.length} error lines)`);
    if (!ok) {
      failures++;
      const shown = log.split("\n").filter((l) => INTERESTING.test(l)).slice(0, 30);
      console.log(shown.map((l) => "      " + l.trim()).join("\n") || "      (no diagnostic lines captured — check clangd output / exit)");
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? "M1 GATE: PASS — clangd resolves every fixture" : `M1 GATE: FAIL (${failures}/${fixtures.length})`}`);
process.exit(failures === 0 ? 0 : 1);
