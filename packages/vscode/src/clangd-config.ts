// Generate the clangd compile DB that turns a qpi.h contract *fragment* into a fully-resolved C++
// translation unit for the editor — WITHOUT the author having to `#include "qpi.h"` (which the
// verifier forbids, and which doc/contracts.md tells authors to add then delete).
//
// The TU is `genWrapperWasm()` VERBATIM — the exact bytes `qinit build` compiles (recipe.ts) — so
// clangd's view never drifts from the real wasm build. The opened contract `.h` resolves as a header
// of this single TU (it is `#include`d mid-wrapper, with qpi.h + the impl headers around it).
//
// Pure (node:fs/path + @qinit/build string templating only — no `vscode`, no Bun), so it is unit-
// testable under `bun test` and bundles cleanly into the Node extension host.
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
  wrapperPath: string;  // <Name>.wasm.wrapper.cpp — the TU clangd parses
  dbPath: string;       // compile_commands.json
  dotClangdPath: string; // <ws>/.clangd
  name: string;
  slot: number;
  args: string[];       // the compile command (argv) written into the DB
}

// The compile arguments mirror recipe.ts:compileWasmContract MINUS the codegen/link-only flags
// (`-O0 -g`, `-Wl,*`, `-mexec-model=reactor`, `-o`) that clangd neither needs nor understands.
// NO_UEFI / LITE_WASM_TU_BUILD / CONTRACT_* are #defined inside the wrapper, not on the command line.
function compileArgs(o: { wasiClang: string; corePath: string; wasiSysroot?: string }): string[] {
  const core = fwd(o.corePath);
  const shim = fwd(join(o.corePath, "src", "extensions", "lite_wasm_intrinsics.h"));
  return [
    fwd(o.wasiClang),              // argv[0]: the real driver, so --query-driver matches it
    "--target=wasm32-wasi",
    "-std=c++20",
    "-fno-rtti",
    "-fno-exceptions",
    "-DLITEDYN_CONTRACT_TU",
    "-include", shim,
    ...(o.wasiSysroot ? [`--sysroot=${fwd(o.wasiSysroot)}`] : []),
    `-I${core}`,
    `-I${core}/src`,
  ];
}

export function generateClangdConfig(o: ClangdInputs): ClangdConfig {
  const name = deriveName(o.contractPath, o.name);
  const slot = o.slot ?? DEFAULT_SLOT;
  const contractPath = resolve(o.contractPath);
  const dir = join(o.workspaceRoot, ".qinit", "clangd");
  mkdirSync(dir, { recursive: true });

  // Inter-contract prelude — the same input the real build feeds genWrapperWasm. Best-effort: a
  // contract with no CALL_OTHER_CONTRACT_* yields "" (without touching corePath), and a resolve
  // failure must not kill IntelliSense for the rest of the file.
  let calleePrelude = "";
  try { calleePrelude = buildCalleePrelude(o.corePath, readFileSync(contractPath, "utf8"), o.dynCallees ?? {}); } catch { /* no prelude */ }

  // The TU = genWrapperWasm verbatim. Pass the contract path forward-slashed so the emitted
  // `#include "<contract>"` is a valid C++ string literal on Windows (backslashes are escape chars).
  const opts: BuildOpts = { contractPath: fwd(contractPath), name, slot, corePath: o.corePath, outDir: dir, calleePrelude };
  const wrapperPath = join(dir, `${name}.wasm.wrapper.cpp`);
  writeFileSync(wrapperPath, genWrapperWasm(opts));

  const args = [...compileArgs(o), fwd(wrapperPath)];

  // compile_commands.json: a single entry whose `file` is the wrapper TU. When the user opens the
  // contract .h, clangd finds it's #included by this TU and serves it in the TU's context.
  const dbPath = join(dir, "compile_commands.json");
  writeFileSync(dbPath, JSON.stringify([{ directory: fwd(dir), file: fwd(wrapperPath), arguments: args }], null, 2) + "\n");

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

  return { dir, wrapperPath, dbPath, dotClangdPath, name, slot, args };
}
