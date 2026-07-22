// Generate a clangd database that resolves QPI contracts without a local qpi.h include.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  genWrapperWasm,
  WASM_CONTRACT_TESTING_HEADER,
  WASM_TEST_UTIL_HEADER,
  type BuildOpts,
} from "@qinit/build/recipe";
import { buildCalleePrelude, type DynCallees } from "@qinit/build/intercontract";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm-slot-layout";

export const DEFAULT_SLOT = DEFAULT_WASM_SLOT_LAYOUT.slotBase;

// clangd requires forward slashes in compile_commands.json and in #include literals, even on Windows.
const fwd = (p: string) => p.replace(/\\/g, "/");

// CONTRACT_STATE_TYPE name: explicit (qinit.json `name`), else the file basename — like build.tsx
// (`cfg.name ?? basename(contractPath)`), so the editor's TU matches a real build. Splits on BOTH `/`
export function deriveName(contractPath: string, explicit?: string): string {
  if (explicit && explicit.length) return explicit;
  return (contractPath.split(/[/\\]/).pop() ?? contractPath).replace(/\.[^.]+$/, "");
}

export interface ClangdInputs {
  contractPath: string; // contract .h (absolute or cwd-relative)
  corePath: string; // core-lite root (from resolveCore)
  wasiClang: string; // wasi-sdk clang++ — the trusted --query-driver
  wasiSysroot?: string; // wasi-sysroot (libc++ headers)
  workspaceRoot: string; // where .qinit/clangd + .clangd are written
  name?: string; // CONTRACT_STATE_TYPE override (qinit.json `name`)
  slot?: number; // CONTRACT_INDEX override (qinit.json `slot`)
  dynCallees?: DynCallees; // inter-contract: Type -> { header, index }
}

export interface ClangdConfig {
  dir: string; // <ws>/.qinit/clangd
  prefixPath: string; // <Name>.prefix.h — the wrapper preamble, force-included before the contract
  contractFile: string; // the contract .h (forward-slashed) — the DB `file` + the clangd --check target
  dbPath: string; // compile_commands.json
  dotClangdPath: string; // <ws>/.clangd
  name: string;
  slot: number;
  args: string[]; // the compile command (argv) written into the DB
}

// Base flags mirror recipe.ts:compileWasmContract MINUS codegen/link-only flags (`-O0 -g`, `-Wl,*`,
// `-mexec-model=reactor`, `-o`). The caller appends `-include <prefix> -x c++ <contract>`.
function compileArgs(o: { wasiClang: string; corePath: string; wasiSysroot?: string }): string[] {
  const core = fwd(o.corePath);
  const shim = fwd(join(o.corePath, "src", CORE_WASM_HEADERS.sdk.platformIntrinsics));
  return [
    fwd(o.wasiClang), // argv[0]: the real driver, so --query-driver matches it
    "--target=wasm32-wasi",
    "-std=c++20",
    "-fno-rtti",
    "-fno-exceptions",
    // Suppress undefined-inline warnings caused by omitting link-only headers from this parse-only TU.
    "-Wno-undefined-inline",
    "-DLITEDYN_CONTRACT_TU",
    "-include",
    shim,
    ...(o.wasiSysroot ? [`--sysroot=${fwd(o.wasiSysroot)}`] : []),
    // Treat core headers as system headers to hide QPI internals from completion and diagnostics.
    "-isystem",
    core,
    "-isystem",
    `${core}/src`,
  ];
}

// Make clangd the C++ provider without overwriting existing editor settings.
export function ensureEditorSettings(workspaceRoot: string): void {
  const dir = join(workspaceRoot, ".vscode");
  const file = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return;
    } // JSONC/garbled → don't risk clobbering
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return;
  }
  // Disable both cpptools IntelliSense and squiggles when the user has not configured them.
  let changed = false;
  for (const [k, v] of [
    ["C_Cpp.intelliSenseEngine", "disabled"],
    ["C_Cpp.errorSquiggles", "disabled"],
  ] as const) {
    if (!(k in settings)) {
      settings[k] = v;
      changed = true;
    }
  }
  if (!changed) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

// The contract's state struct name (`struct <Name> : public ContractBase`) — authoritative for
// CONTRACT_STATE_TYPE, since the file's content may diverge from qinit.json (renamed/pasted code).
export function detectStateType(source: string): string | undefined {
  return source.match(/\bstruct\s+(\w+)\s*:\s*public\s+ContractBase\b/)?.[1];
}

export function generateClangdConfig(o: ClangdInputs): ClangdConfig {
  const contractPath = resolve(o.contractPath);
  const contractFile = fwd(contractPath);
  let source = "";
  try {
    source = readFileSync(contractPath, "utf8");
  } catch {
    /* not yet on disk */
  }
  // Prefer the state type parsed from source, then fall back to the configured or derived name.
  const detected = detectStateType(source);
  const name =
    detected && detected !== "CONTRACT_STATE_TYPE" ? detected : deriveName(o.contractPath, o.name);
  const slot = o.slot ?? DEFAULT_SLOT;
  const dir = join(o.workspaceRoot, ".qinit", "clangd");
  mkdirSync(dir, { recursive: true });

  // Build the same inter-contract prelude as the real compiler, best-effort.
  let calleePrelude = "";
  try {
    calleePrelude = buildCalleePrelude(o.corePath, source, o.dynCallees ?? {});
  } catch {
    /* no prelude */
  }

  // Preamble = genWrapperWasm() up to (not including) the `#include "<contract>"`. It carries NO_UEFI,
  // LITE_WASM_TU_BUILD, the std prefix, pre_qpi_def.h, qpi.h, CONTRACT_INDEX/STATE_TYPE, etc.
  const opts: BuildOpts = {
    contractPath: contractFile,
    name,
    slot,
    corePath: o.corePath,
    outDir: dir,
    calleePrelude,
  };
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
  try {
    const j = JSON.parse(readFileSync(dbPath, "utf8"));
    if (Array.isArray(j)) entries = j;
  } catch {
    /* fresh or corrupt DB → start clean */
  }
  entries = entries.filter((e) => e && e.file !== entry.file);
  entries.push(entry);
  writeFileSync(dbPath, JSON.stringify(entries, null, 2) + "\n");

  // Workspace .clangd: point clangd at the DB. Written only if absent, so a user's own .clangd wins.
  const dotClangdPath = join(o.workspaceRoot, ".clangd");
  if (!existsSync(dotClangdPath)) {
    writeFileSync(
      dotClangdPath,
      [
        "# Generated by the Qubic QPI extension — points clangd at the per-contract compile DB, and",
        "# trims the cross-scope/OS completion flood. Member + qualified completion (qpi., Array., QPI::)",
        "# are AST-based and unaffected.",
        "CompileFlags:",
        "  CompilationDatabase: .qinit/clangd",
        "Completion:",
        "  AllScopes: No",
        "  HeaderInsertion: Never",
        "",
      ].join("\n"),
    );
  }

  ensureEditorSettings(o.workspaceRoot); // clangd is the C++ provider here — silence cpptools squiggles

  return { dir, prefixPath, contractFile, dbPath, dotClangdPath, name, slot, args };
}

// Generate a clangd entry for a standard gtest with the contract and virtual-node harness.
export function generateTestClangdConfig(o: ClangdInputs & { testPath: string }): {
  dbPath: string;
  prefixPath: string;
  testFile: string;
} {
  const contractPath = resolve(o.contractPath);
  const contractFile = fwd(contractPath);
  let source = "";
  try {
    source = readFileSync(contractPath, "utf8");
  } catch {
    /* contract not yet on disk — best-effort preamble */
  }

  const detected = detectStateType(source);
  const name =
    detected && detected !== "CONTRACT_STATE_TYPE" ? detected : deriveName(o.contractPath, o.name);
  const slot = o.slot ?? DEFAULT_SLOT;
  const dir = join(o.workspaceRoot, ".qinit", "clangd");
  mkdirSync(dir, { recursive: true });

  let calleePrelude = "";
  try {
    calleePrelude = buildCalleePrelude(o.corePath, source, o.dynCallees ?? {});
  } catch {
    /* no prelude */
  }

  // A non-empty testSource asks genWrapperWasm to inject the private TEST/EXPECT registry. The real test file
  // remains clangd's main file and includes contract_testing.h in the ordinary core-lite style.
  const opts: BuildOpts = {
    contractPath: contractFile,
    name,
    slot,
    corePath: o.corePath,
    outDir: dir,
    calleePrelude,
  };
  const preamble = genWrapperWasm({ ...opts, testSource: "\n", testPath: "gtest-prefix.h" });
  writeFileSync(join(dir, "contract_testing.h"), WASM_CONTRACT_TESTING_HEADER);
  writeFileSync(join(dir, "test_util.h"), WASM_TEST_UTIL_HEADER);

  const testPath = resolve(o.testPath);
  const testFile = fwd(testPath);
  const testBase = (testPath.split(/[/\\]/).pop() ?? "test").replace(/\.[^.]+$/, "");
  const prefixPath = join(dir, `${testBase}.test.prefix.h`);
  writeFileSync(prefixPath, preamble);

  const args = [
    ...compileArgs(o),
    "-I",
    fwd(dir),
    "-include",
    fwd(prefixPath),
    "-x",
    "c++",
    testFile,
  ];
  const dbPath = join(dir, "compile_commands.json");
  const entry = { directory: fwd(dir), file: testFile, arguments: args };
  let entries: Array<{ file?: string }> = [];
  try {
    const j = JSON.parse(readFileSync(dbPath, "utf8"));
    if (Array.isArray(j)) entries = j;
  } catch {
    /* fresh or corrupt DB → start clean */
  }
  entries = entries.filter((e) => e && e.file !== entry.file);
  entries.push(entry);
  writeFileSync(dbPath, JSON.stringify(entries, null, 2) + "\n");

  // A test may be opened before any contract — make sure clangd is pointed at the DB + cpptools is quiet.
  if (!existsSync(join(o.workspaceRoot, ".clangd"))) {
    writeFileSync(
      join(o.workspaceRoot, ".clangd"),
      [
        "# Generated by the Qubic QPI extension — points clangd at the per-contract/test compile DB.",
        "CompileFlags:",
        "  CompilationDatabase: .qinit/clangd",
        "Completion:",
        "  AllScopes: No",
        "  HeaderInsertion: Never",
        "",
      ].join("\n"),
    );
  }
  ensureEditorSettings(o.workspaceRoot);

  return { dbPath, prefixPath, testFile };
}
