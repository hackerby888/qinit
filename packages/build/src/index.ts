/// <reference path="./text-assets.d.ts" />
// qinit build: contract .h -> wasm module (run by the node's WAMR engine) + K12 hash + IDL.
import { statSync, readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { compileWasmContract, type BuildOpts } from "./recipe";
// Embedded as text by `bun build --compile` (import.meta.dir asset files aren't bundled into the binary).
import WASM_CONTRACT_TESTING_H from "./assets/wasm_contract_testing.h" with { type: "text" };
import TEST_UTIL_H from "./assets/test_util.h" with { type: "text" };
import { extractIdl, type ContractIdl } from "./idl";
import { buildCalleePrelude } from "./intercontract";
import { verifyContract, type VerifyResult } from "./verify";
import { systemContracts } from "./system-contracts";
import { k12Hex } from "@qinit/core";
import { qpiPrelude } from "./prelude";

export { qpiPrelude } from "./prelude";
export type { BuildOpts } from "./recipe";
export { genWrapper, genWrapperWasm } from "./recipe";
export { buildCalleePrelude, parseRegisters, scanCallees, parseContractDef } from "./intercontract";
export type { DynCallees, CalleeDef } from "./intercontract";
export { extractIdl } from "./idl";
export type { ContractIdl, IdlEntry, Field, LogStruct, EnumDef } from "./idl";
export { systemContracts, systemNames, type SystemContract } from "./system-contracts";
export { generateClient } from "./gen-client";
export { testRuntimeSource, sampleTest } from "./gen-test";
export { genStdGtest } from "./gen-std-gtest";
export { buildSnapshot } from "./snapshot";
export type { SnapshotResult } from "./snapshot";
export { verifyContract, resolveVerifyTool } from "./verify";
export type { VerifyResult } from "./verify";

export interface BuildResult {
  ok: boolean;
  so?: string;     // path to the built wasm module (kept the `so` name: the artifact the deploy path uploads)
  size?: number;
  hash?: string;
  idl?: ContractIdl;
  verify?: VerifyResult;
  debugWasm?: string;   // -g DWARF sidecar (deployed wasm is stripped)
  linesJson?: string;   // {fileOffset -> file:line:func} map for source-mapped trap backtraces
  stderr?: string;
  idlError?: string;    // set (instead of silently dropping idl) when extractIdl throws on a compiled contract
}

export async function buildContract(o: BuildOpts): Promise<BuildResult> {
  // Protocol-rule gate first (cheap, fails before clang): reject contracts that break the
  // qpi.h restrictions. Skipped (not failed) when the verify tool isn't synced on this box.
  // Inter-contract callee names (--callee + CALL/INVOKE_OTHER_CONTRACT) are passed so the tool's
  // false "scope resolution with prefix <DynCallee>" errors don't block a legit inter-contract deploy.
  const calleeNames = [...new Set([
    ...Object.keys(o.dynCallees ?? {}),
    ...[...readFileSync(o.contractPath, "utf8").matchAll(/(?:CALL|INVOKE)_OTHER_CONTRACT_\w+\s*\(\s*(\w+)/g)].map((m) => m[1]),
  ])];
  const verify = o.skipVerify
    ? { available: false, ok: true, oracle: false, errors: [] as string[] }
    : await verifyContract(o.contractPath, o.name, { allowedPrefixes: calleeNames });
  if (verify.available && !verify.ok) {
    return { ok: false, verify, stderr: ["Qubic protocol violations:", ...verify.errors.map((e) => "  • " + e)].join("\n") };
  }

  // Inter-contract: scan the contract for CALL_OTHER_CONTRACT_* and auto-derive the callee prelude
  // (callee type headers at their indices + per-fn inputType constants) from contract_def.h.
  let calleePrelude = o.calleePrelude;
  if (calleePrelude === undefined) {
    try { calleePrelude = buildCalleePrelude(o.corePath, readFileSync(o.contractPath, "utf8"), o.dynCallees ?? {}, o.stateType ?? o.name); }
    catch (e: any) { return { ok: false, stderr: "inter-contract resolve failed: " + String(e?.message ?? e) }; }
  }
  // Compile the contract to a wasm module (run by the node's WAMR engine). One platform-independent
  // artifact, deployed via the chunked-upload path (the node magic-sniffs '\0asm' -> wasm engine).
  const w = await compileWasmContract({ ...o, calleePrelude });
  if (!w.ok) return { ok: false, so: w.wasm, stderr: w.stderr };
  const size = statSync(w.wasm).size;
  let hash: string | undefined;
  try { hash = await k12Hex(new Uint8Array(readFileSync(w.wasm))); } catch { hash = undefined; }
  let idl: ContractIdl | undefined, idlError: string | undefined;
  try { idl = extractIdl(readFileSync(o.contractPath, "utf8"), o.name, { prelude: o.corePath ? qpiPrelude(o.corePath) : undefined }); } catch (e: any) { idlError = String(e?.message ?? e); }
  return { ok: true, so: w.wasm, size, hash, idl, idlError, verify, debugWasm: w.debugWasm, linesJson: w.linesJson };
}

// Compile a corpus file (core-lite/test/contract_X.cpp) into a runner wasm by redirecting its
// `#include "contract_testing.h"` to the qinit-shipped `wasm_contract_testing.h` header.
// The corpus body is inlined as testSource; the header asset is written into outDir so the
// quote-include resolves relative to the wrapper TU's physical location.
export async function buildCorpusRunner(o: {
  corpusPath: string;
  contractPath: string;
  name: string;
  stateType: string;
  slot: number;
  corePath: string;
  outDir: string;
  arenaSz?: number;
}): Promise<BuildResult> {
  const raw = (await readFile(o.corpusPath, "utf8")).replace(/^﻿/, "");

  const testSource = raw
    .replace(/^#include\s+"contract_testing\.h"\s*$/m, '#include "wasm_contract_testing.h"')
    .replace(/^#include\s+"oracle_testing\.h".*$/m, "");

  await mkdir(o.outDir, { recursive: true });

  await writeFile(join(o.outDir, "wasm_contract_testing.h"), WASM_CONTRACT_TESTING_H);
  // Some corpora also `#include "test_util.h"` (asset-name helpers etc.); provide the wasm-mode stub.
  await writeFile(join(o.outDir, "test_util.h"), TEST_UTIL_H);

  // The corpus runner is a test tool, not a deployed contract, so it has no need for the recipe's
  // -O0 -g debuggability. Build it -O2 (the trailing -O wins over the recipe's -O0): corpus checkers
  // sweep whole fixed-capacity state arrays (e.g. QEARN's 4,194,304-entry locker) every assertion, and
  // -O0 makes those loops the dominant cost. The private Wasm EXPECT_*/ASSERT_* macros expand to a bare `return;`
  // (under `if (fatal)`), a C++ default-error in non-void corpus helpers; native uses real gtest (no
  // return), so relax it here — scoped to the corpus path, production deploys keep the strict default.
  // QINIT_CORPUS_RUNNER shrinks the runner's dead in-module state buffer to one page (lite_wasm_tu.h): the
  // contract under test runs in engine-deployed instances, and a full-size buffer would push the runner's
  // data end into the shared-memory region where those instances live.
  const extraCompileFlags = ["-O2", "-Wno-error=return-mismatch", "-DQINIT_CORPUS_RUNNER"];

  // When the corpus pulls real <iostream>/<ostream> itself, suppress the harness's std::cout stubs so
  // they don't collide with the real stream objects (an ambiguous-reference error otherwise).
  if (/^#include\s*<(iostream|ostream)>/m.test(raw)) {
    extraCompileFlags.push("-DQINIT_HAVE_IOSTREAM");
  }

  // Derive the inter-contract callee prelude from the contract AND the corpus: a corpus often references a
  // sibling contract's types directly (e.g. `QX::IssueAsset_input` to seed an asset) even when the contract
  // under test never calls it, so the contract-only scan misses it and the runner fails to compile.
  let calleePrelude: string | undefined;
  try {
    const contractSrc = readFileSync(o.contractPath, "utf8");
    calleePrelude = buildCalleePrelude(o.corePath, `${contractSrc}\n${testSource}`, {}, o.stateType);
  } catch { /* fall back to buildContract's contract-only derivation */ }

  return buildContract({
    contractPath: o.contractPath,
    name: o.name,
    stateType: o.stateType,
    slot: o.slot,
    corePath: o.corePath,
    outDir: o.outDir,
    arenaSz: o.arenaSz ?? 8 * 1024 * 1024,
    skipVerify: true,
    testSource,
    testPath: basename(o.corpusPath),
    extraCompileFlags,
    calleePrelude,
  });
}

// Compile a named built-in system contract (QX, QEARN, …) from the core snapshot catalog. Shared by the CLI
// (`qinit system`) and the backend's compile-system route. skipVerify because system code uses sysproc macros
// the protocol verifier can't parse; these are trusted core sources. Returns the build result + the contract's
// canonical slot index.
export async function buildSystemContract(
  name: string, corePath: string, opts: { outDir?: string; wasmClang?: string; wasmSysroot?: string } = {},
): Promise<BuildResult & { index?: number }> {
  const catalog = systemContracts(corePath);
  const c = catalog.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!c) {
    return { ok: false, stderr: `unknown system contract '${name}' — have: ${catalog.map((x) => x.name).join(", ")}` };
  }

  const r = await buildContract({
    contractPath: join(corePath, "src", "contracts", c.file),
    name: c.name, stateType: c.stateType, slot: c.index, corePath,
    outDir: opts.outDir ?? join(tmpdir(), "qinit-system"),
    skipVerify: true, wasmClang: opts.wasmClang, wasmSysroot: opts.wasmSysroot,
  });
  return { ...r, index: c.index };
}
