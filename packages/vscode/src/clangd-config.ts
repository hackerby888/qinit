import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { contractStateType } from "./project-util";

export const DEFAULT_SLOT = DEFAULT_WASM_SLOT_LAYOUT.slotBase;

const forwardSlashes = (path: string) => path.replace(/\\/g, "/");

export function deriveName(contractPath: string, explicit?: string): string {
  if (explicit) return explicit;
  return (contractPath.split(/[/\\]/).pop() ?? contractPath).replace(/\.[^.]+$/, "");
}

export interface ClangdInputs {
  contractPath: string;
  corePath: string;
  dataRoot?: string;
  workspaceRoot: string;
  name?: string;
  slot?: number;
  dynCallees?: DynCallees;
}

export interface ClangdConfig {
  dir: string;
  prefixPath: string;
  contractFile: string;
  dbPath: string;
  dotClangdPath: string;
  clangdConfigured: boolean;
  restartRequired: boolean;
  name: string;
  slot: number;
  args: string[];
}

export interface TestClangdConfig {
  dbPath: string;
  prefixPath: string;
  testFile: string;
  dotClangdPath: string;
  clangdConfigured: boolean;
  restartRequired: boolean;
}

function compileArgs(corePath: string): string[] {
  const core = forwardSlashes(corePath);
  const shim = forwardSlashes(join(corePath, "src", CORE_WASM_HEADERS.sdk.platformIntrinsics));
  const sysroot = forwardSlashes(join(corePath, "wasi-sdk", "share", "wasi-sysroot"));
  return [
    "clang++",
    "--target=wasm32-wasi",
    "-std=c++20",
    "-fno-rtti",
    "-fno-exceptions",
    "-Wno-undefined-inline",
    "-DLITEDYN_CONTRACT_TU",
    "-include",
    shim,
    `--sysroot=${sysroot}`,
    "-isystem",
    core,
    "-isystem",
    `${core}/src`,
  ];
}

export function ensureEditorSettings(workspaceRoot: string): void {
  const dir = join(workspaceRoot, ".vscode");
  const file = join(dir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return;
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return;
  }

  let changed = false;
  for (const [key, value] of [
    ["C_Cpp.intelliSenseEngine", "disabled"],
    ["C_Cpp.errorSquiggles", "disabled"],
  ] as const) {
    if (key in settings) continue;
    settings[key] = value;
    changed = true;
  }
  if (!changed) return;

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export function detectStateType(source: string): string | undefined {
  return contractStateType(source);
}

function sourceDetails(o: ClangdInputs): {
  contractFile: string;
  name: string;
  slot: number;
  dir: string;
  options: BuildOpts;
} {
  const contractPath = resolve(o.contractPath);
  const contractFile = forwardSlashes(contractPath);
  let source = "";
  try {
    source = readFileSync(contractPath, "utf8");
  } catch {}

  const detected = contractStateType(source);
  const name =
    detected && detected !== "CONTRACT_STATE_TYPE"
      ? detected
      : deriveName(o.contractPath, o.name);
  const slot = o.slot ?? DEFAULT_SLOT;
  const dir = join(o.dataRoot ?? join(o.workspaceRoot, ".qpi"), "clangd");
  mkdirSync(dir, { recursive: true });

  let calleePrelude = "";
  try {
    calleePrelude = buildCalleePrelude(o.corePath, source, o.dynCallees ?? {});
  } catch {}

  const options: BuildOpts = {
    contractPath: contractFile,
    name,
    slot,
    corePath: o.corePath,
    outDir: dir,
    calleePrelude,
  };
  return { contractFile, name, slot, dir, options };
}

function writeCompileEntry(
  dir: string,
  file: string,
  args: string[],
): { path: string; added: boolean } {
  const dbPath = join(dir, "compile_commands.json");
  const entry = { directory: forwardSlashes(dir), file, arguments: args };
  let entries: Array<{ file?: string }> = [];
  try {
    const parsed = JSON.parse(readFileSync(dbPath, "utf8"));
    if (Array.isArray(parsed)) entries = parsed;
  } catch {}

  const added = !entries.some((existing) => existing?.file === file);
  entries = entries.filter((existing) => existing?.file !== file);
  entries.push(entry);
  writeFileSync(dbPath, JSON.stringify(entries, null, 2) + "\n");
  return { path: dbPath, added };
}

function ensureClangdConfig(
  workspaceRoot: string,
  databaseDir: string,
): { path: string; configured: boolean } {
  const path = join(workspaceRoot, ".clangd");
  const database = forwardSlashes(databaseDir);
  if (existsSync(path)) {
    return {
      path,
      configured: readFileSync(path, "utf8").includes(database),
    };
  }

  writeFileSync(
    path,
    [
      "# Generated by the Qubic QPI extension.",
      "CompileFlags:",
      `  CompilationDatabase: ${JSON.stringify(database)}`,
      "Completion:",
      "  AllScopes: No",
      "  HeaderInsertion: Never",
      "",
    ].join("\n"),
  );
  return { path, configured: true };
}

export function generateClangdConfig(o: ClangdInputs): ClangdConfig {
  const details = sourceDetails(o);
  const wrapper = genWrapperWasm(details.options);
  const contractInclude = `#include "${details.contractFile}"`;
  const includeOffset = wrapper.indexOf(contractInclude);
  const preamble = includeOffset >= 0 ? wrapper.slice(0, includeOffset) : wrapper;
  const prefixPath = join(details.dir, `${details.name}.prefix.h`);
  writeFileSync(prefixPath, preamble);

  const args = [
    ...compileArgs(o.corePath),
    "-include",
    forwardSlashes(prefixPath),
    "-x",
    "c++",
    details.contractFile,
  ];
  const compileEntry = writeCompileEntry(details.dir, details.contractFile, args);
  const clangd = ensureClangdConfig(o.workspaceRoot, details.dir);
  ensureEditorSettings(o.workspaceRoot);

  return {
    dir: details.dir,
    prefixPath,
    contractFile: details.contractFile,
    dbPath: compileEntry.path,
    dotClangdPath: clangd.path,
    clangdConfigured: clangd.configured,
    restartRequired: compileEntry.added,
    name: details.name,
    slot: details.slot,
    args,
  };
}

export function generateTestClangdConfig(
  o: ClangdInputs & { testPath: string },
): TestClangdConfig {
  const details = sourceDetails(o);
  const preamble = genWrapperWasm({
    ...details.options,
    testSource: "\n",
    testPath: "gtest-prefix.h",
  });
  writeFileSync(join(details.dir, "contract_testing.h"), WASM_CONTRACT_TESTING_HEADER);
  writeFileSync(join(details.dir, "test_util.h"), WASM_TEST_UTIL_HEADER);

  const testPath = resolve(o.testPath);
  const testFile = forwardSlashes(testPath);
  const testBase = (testPath.split(/[/\\]/).pop() ?? "test").replace(/\.[^.]+$/, "");
  const prefixPath = join(details.dir, `${testBase}.test.prefix.h`);
  writeFileSync(prefixPath, preamble);

  const args = [
    ...compileArgs(o.corePath),
    "-I",
    forwardSlashes(details.dir),
    "-include",
    forwardSlashes(prefixPath),
    "-x",
    "c++",
    testFile,
  ];
  const compileEntry = writeCompileEntry(details.dir, testFile, args);
  const clangd = ensureClangdConfig(o.workspaceRoot, details.dir);
  ensureEditorSettings(o.workspaceRoot);

  return {
    dbPath: compileEntry.path,
    prefixPath,
    testFile,
    dotClangdPath: clangd.path,
    clangdConfigured: clangd.configured,
    restartRequired: compileEntry.added,
  };
}
