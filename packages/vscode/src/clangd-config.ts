// Generate the clangd compile DB that turns a qpi.h-constrained contract .h into a fully-resolved C++
// translation unit FOR THE EDITOR — without the author needing the `#include "qpi.h"` dev-hack, and
// without the Microsoft C/C++ engine redlining code it can't parse.
//
// Mechanism: the real wasm TU is `genWrapperWasm()` (qinit build's exact recipe). For the editor we
// take its PREAMBLE (everything before the `#include "<contract>"`) and write it as `<Name>.prefix.h`,
// then add a compile_commands.json entry whose `file` is the CONTRACT ITSELF with `-include <prefix.h>`.
// clangd parses the opened contract as the main file WITH that preamble in scope, so CONTRACT_INDEX /
// CONTRACT_STATE_TYPE / qpi.h are all defined → the PUBLIC_*/REGISTER_* macros resolve and
// `state.mut()` / `input` / containers complete.
//
// Why not `file` = the wrapper.cpp? Because for "open the contract", clangd parses the OPENED file as
// the main file using the chosen command — the wrapper's in-source `#define`s never reach it, so the
// macros break (undeclared CONTRACT_INDEX, __FunctionOrProcedureBeginEndGuard, …). The trailing impl
// headers in the full wrapper aren't needed merely to PARSE the contract, so the preamble suffices.
//
// Pure (node:fs/path + @qinit/build string templating only — no `vscode`, no Bun).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { genWrapperWasm, type BuildOpts } from "@qinit/build/recipe";
import { buildCalleePrelude, type DynCallees } from "@qinit/build/intercontract";

export const DEFAULT_SLOT = 28; // mirrors packages/cli/src/commands/build.tsx (`cfg.slot ?? 28`)

// clangd requires forward slashes in compile_commands.json and in #include literals, even on Windows.
const fwd = (p: string) => p.replace(/\\/g, "/");

// CONTRACT_STATE_TYPE name: explicit (qinit.json `name`), else the file basename — identical to
// build.tsx (`cfg.name ?? basename(contractPath)`), so the editor's TU matches a real build.
export function deriveName(contractPath: string, explicit?: string): string {
  return explicit && explicit.length ? explicit : basename(contractPath).replace(/\.[^.]+$/, "");
}

export interface ClangdInputs {
  contractPath: string;     // contract .h (absolute or cwd-relative)
  corePath: string;         // core-lite root (from resolveCore)
  wasiClang: string;        // wasi-sdk clang++ — the trusted --query-driver
  wasiSysroot?: string;     // wasi-sysroot (libc++ headers)
  workspaceRoot: string;    // where .qinit/clangd + .clangd are written
  name?: string;            // CONTRACT_STATE_TYPE override (qinit.json `name`)
  slot?: number;            // CONTRACT_INDEX override (qinit.json `slot`)
  dynCallees?: DynCallees;  // inter-contract: Type -> { header, index }
}

export interface ClangdConfig {
  dir: string;          // <ws>/.qinit/clangd
  prefixPath: string;   // <Name>.prefix.h — the wrapper preamble, force-included before the contract
  contractFile: string; // the contract .h (forward-slashed) — the DB `file` + the clangd --check target
  dbPath: string;       // compile_commands.json
  dotClangdPath: string; // <ws>/.clangd
  name: string;
  slot: number;
  args: string[];       // the compile command (argv) written into the DB
}

// Base flags mirror recipe.ts:compileWasmContract MINUS codegen/link-only flags (`-O0 -g`, `-Wl,*`,
// `-mexec-model=reactor`, `-o`). The caller appends `-include <prefix> -x c++ <contract>`.
function compileArgs(o: { wasiClang: string; corePath: string; wasiSysroot?: string }): string[] {
  const core = fwd(o.corePath);
  const shim = fwd(join(o.corePath, "src", "extensions", "lite_wasm_intrinsics.h"));
  return [
    fwd(o.wasiClang),              // argv[0]: the real driver, so --query-driver matches it
    "--target=wasm32-wasi",
    "-std=c++20",
    "-fno-rtti",
    "-fno-exceptions",
    // Editor-only suppressions for artifacts of the parse-only TU (we omit the post-contract impl
    // headers that the real build links): -Wundefined-inline fires because qpi.h declares inlines
    // (__qpiAllocLocals/__qpiFreeLocals, used by CALL/_WITH_LOCALS) whose bodies live in those omitted
    // headers. These are valid QPI — never redline them. (The real build, which includes the impls,
    // doesn't see these, so the editor stays in step.)
    "-Wno-undefined-inline",
    "-DLITEDYN_CONTRACT_TU",
    "-include", shim,
    ...(o.wasiSysroot ? [`--sysroot=${fwd(o.wasiSysroot)}`] : []),
    `-I${core}`,
    `-I${core}/src`,
  ];
}

// Make clangd the sole C++ IntelliSense provider in the project: disable the Microsoft C/C++
// extension's engine so it never squiggles QPI code it can't understand (no qpi.h). Merge-safe: only
// adds the key when absent, and never rewrites a settings.json we can't parse cleanly.
export function ensureEditorSettings(workspaceRoot: string): void {
  const dir = join(workspaceRoot, ".vscode");
  const file = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, "utf8")); } catch { return; } // JSONC/garbled → don't risk clobbering
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return;
  }
  // clangd is the C++ provider here. Turn the MS C/C++ extension's engine off AND force its error
  // squiggles off — its default `enabledIfIncludesResolve` still squiggles "cannot open qpi.h" using
  // its own includePath (it doesn't read our compile DB). Set each only if absent, so a user choice wins.
  let changed = false;
  for (const [k, v] of [["C_Cpp.intelliSenseEngine", "disabled"], ["C_Cpp.errorSquiggles", "disabled"]] as const) {
    if (!(k in settings)) { settings[k] = v; changed = true; }
  }
  if (!changed) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export function generateClangdConfig(o: ClangdInputs): ClangdConfig {
  const name = deriveName(o.contractPath, o.name);
  const slot = o.slot ?? DEFAULT_SLOT;
  const contractPath = resolve(o.contractPath);
  const contractFile = fwd(contractPath);
  const dir = join(o.workspaceRoot, ".qinit", "clangd");
  mkdirSync(dir, { recursive: true });

  // Inter-contract prelude — same input the real build feeds genWrapperWasm. Best-effort: a contract
  // with no CALL_OTHER_CONTRACT_* yields "" (without touching corePath); a resolve failure must not
  // kill IntelliSense.
  let calleePrelude = "";
  try { calleePrelude = buildCalleePrelude(o.corePath, readFileSync(contractPath, "utf8"), o.dynCallees ?? {}); } catch { /* no prelude */ }

  // Preamble = genWrapperWasm() up to (not including) the `#include "<contract>"`. It carries NO_UEFI,
  // LITE_WASM_TU_BUILD, the std prefix, pre_qpi_def.h, qpi.h, CONTRACT_INDEX/STATE_TYPE, etc.
  const opts: BuildOpts = { contractPath: contractFile, name, slot, corePath: o.corePath, outDir: dir, calleePrelude };
  const wrapper = genWrapperWasm(opts);
  const cut = wrapper.indexOf(`#include "${contractFile}"`);
  const preamble = cut >= 0 ? wrapper.slice(0, cut) : wrapper;
  const prefixPath = join(dir, `${name}.prefix.h`);
  writeFileSync(prefixPath, preamble);

  // The contract is parsed as the main file WITH the preamble force-included before it.
  const args = [...compileArgs(o), "-include", fwd(prefixPath), "-x", "c++", contractFile];

  // compile_commands.json — `file` is the CONTRACT, so clangd uses this exact command when the contract
  // is opened (no fragile header→TU heuristic). MERGE one entry per contract (multi-contract projects).
  const dbPath = join(dir, "compile_commands.json");
  const entry = { directory: fwd(dir), file: contractFile, arguments: args };
  let entries: Array<{ file?: string }> = [];
  try { const j = JSON.parse(readFileSync(dbPath, "utf8")); if (Array.isArray(j)) entries = j; } catch { /* fresh or corrupt DB → start clean */ }
  entries = entries.filter((e) => e && e.file !== entry.file);
  entries.push(entry);
  writeFileSync(dbPath, JSON.stringify(entries, null, 2) + "\n");

  // Workspace .clangd: point clangd at the DB. Written only if absent, so a user's own .clangd wins.
  const dotClangdPath = join(o.workspaceRoot, ".clangd");
  if (!existsSync(dotClangdPath)) {
    writeFileSync(dotClangdPath, [
      "# Generated by the Qubic QPI extension — points clangd at the per-contract compile DB.",
      "CompileFlags:",
      "  CompilationDatabase: .qinit/clangd",
      "",
    ].join("\n"));
  }

  ensureEditorSettings(o.workspaceRoot); // clangd is the C++ provider here — silence cpptools squiggles

  return { dir, prefixPath, contractFile, dbPath, dotClangdPath, name, slot, args };
}
