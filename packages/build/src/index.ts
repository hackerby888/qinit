/// <reference path="./text-assets.d.ts" />
// qinit build: contract .h -> wasm module (run by the node's WAMR engine) + K12 hash + IDL.
import { statSync, readFileSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  compileWasmContract,
  WASM_CONTRACT_TESTING_HEADER,
  type BuildOpts,
} from "./recipe";
// Embedded as text by `bun build --compile` (import.meta.dir asset files aren't bundled into the binary).
import TEST_UTIL_H from "./assets/test_util.h" with { type: "text" };
import { extractIdl, type ContractIdl } from "./idl";
import { buildCalleePrelude } from "./intercontract";
import { verifyContract, type VerifyResult } from "./verify";
import { systemContracts } from "./system-contracts";
import { k12Hex } from "@qinit/core";
import { analyzeContract } from "@qinit/compile/analyzer";
import { loadQpiHeader } from "@qinit/compile";

export type { BuildOpts } from "./recipe";
export { genWrapperWasm } from "./recipe";
export { buildCalleePrelude, parseRegisters, scanCallees, parseContractDef } from "./intercontract";
export type { DynCallees, CalleeDef } from "./intercontract";
export { extractIdl } from "./idl";
export type { ContractIdl, IdlEntry, Field, LogStruct, EnumDef } from "./idl";
export { systemContracts, systemNames, type SystemContract } from "./system-contracts";
export { generateClient } from "./gen-client";
export { testRuntimeSource, sampleTest } from "./gen-test";
export { genStdGtest } from "./gen-std-gtest";
export { buildSnapshot } from "./snapshot";
export type { SnapshotOptions, SnapshotResult } from "./snapshot";
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
  const source = readFileSync(o.contractPath, "utf8");
  let qpiHeader: string | undefined;
  let qpiHeaderError: string | undefined;
  try {
    qpiHeader = o.corePath ? loadQpiHeader(o.corePath) : undefined;
  } catch (error: any) {
    qpiHeader = undefined;
    qpiHeaderError = String(error?.message ?? error);
  }

  // Protocol-rule gate first (cheap, fails before clang): reject contracts that break the
  // qpi.h restrictions. Skipped (not failed) when the verify tool isn't synced on this box.
  const calls = analyzeContract({
    source,
    name: o.stateType ?? o.name,
    slot: o.slot,
    qpiHeader,
  }).calls;
  const calleeNames = [
    ...new Set([
      ...Object.keys(o.dynCallees ?? {}),
      ...calls.map((call) => call.callee),
    ]),
  ];
  const verify = o.skipVerify
    ? { available: false, ok: true, oracle: false, errors: [] as string[] }
    : await verifyContract(o.contractPath, o.name, { allowedPrefixes: calleeNames });
  if (verify.available && !verify.ok) {
    return {
      ok: false,
      verify,
      stderr: ["Qubic protocol violations:", ...verify.errors.map((e) => "  • " + e)].join("\n"),
    };
  }

  // Inter-contract: scan the contract for CALL_OTHER_CONTRACT_* and auto-derive the callee prelude
  // (callee type headers at their indices + per-fn inputType constants) from contract_def.h.
  let calleePrelude = o.calleePrelude;
  if (calleePrelude === undefined) {
    try {
      calleePrelude = buildCalleePrelude(
        o.corePath,
        source,
        o.dynCallees ?? {},
        o.stateType ?? o.name,
      );
    } catch (e: any) {
      return { ok: false, stderr: "inter-contract resolve failed: " + String(e?.message ?? e) };
    }
  }
  // Compile the contract to a wasm module (run by the node's WAMR engine). One platform-independent
  // artifact, deployed via the chunked-upload path (the node magic-sniffs '\0asm' -> wasm engine).
  const compiled = await compileWasmContract({ ...o, calleePrelude });
  if (!compiled.ok) return { ok: false, so: compiled.wasm, stderr: compiled.stderr };
  const size = statSync(compiled.wasm).size;
  let hash: string | undefined;
  try {
    hash = await k12Hex(new Uint8Array(readFileSync(compiled.wasm)));
  } catch {
    hash = undefined;
  }
  let idl: ContractIdl | undefined;
  let idlError: string | undefined;
  try {
    if (qpiHeaderError) {
      throw new Error(qpiHeaderError);
    }
    idl = extractIdl(source, o.name, {
      slot: o.slot,
      qpiHeader,
      stateType: o.stateType,
    });
  } catch (e: any) {
    idlError = String(e?.message ?? e);
  }
  return {
    ok: true,
    so: compiled.wasm,
    size,
    hash,
    idl,
    idlError,
    verify,
    debugWasm: compiled.debugWasm,
    linesJson: compiled.linesJson,
  };
}

// Compile a corpus file (core-lite/test/contract_X.cpp) into a runner wasm by redirecting its
// `#include "contract_testing.h"` to the qinit-shipped `wasm_contract_testing.h` header.
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

  await writeFile(join(o.outDir, "wasm_contract_testing.h"), WASM_CONTRACT_TESTING_HEADER);
  // Some corpora also `#include "test_util.h"` (asset-name helpers etc.); provide the wasm-mode stub.
  await writeFile(join(o.outDir, "test_util.h"), TEST_UTIL_H);

  // Corpus runners do not need deployed-contract debugging; the trailing -O2 overrides the recipe's -O0.
  const extraCompileFlags = ["-O2", "-Wno-error=return-mismatch", "-DQINIT_CORPUS_RUNNER"];

  // When the corpus pulls real <iostream>/<ostream> itself, suppress the harness's std::cout stubs so
  // they don't collide with the real stream objects (an ambiguous-reference error otherwise).
  if (/^#include\s*<(iostream|ostream)>/m.test(raw)) {
    extraCompileFlags.push("-DQINIT_HAVE_IOSTREAM");
  }

  // Include sibling types referenced only by the corpus, not just callees used by the contract.
  let calleePrelude: string | undefined;
  try {
    const contractSrc = readFileSync(o.contractPath, "utf8");
    calleePrelude = buildCalleePrelude(o.corePath, `${contractSrc}\n${testSource}`, {}, o.stateType);
  } catch {
    // Fall back to buildContract's contract-only derivation.
  }

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

// System contracts use sysproc macros unsupported by the verifier, so buildContract skips verification.
export async function buildSystemContract(
  name: string,
  corePath: string,
  opts: { outDir?: string; wasmClang?: string; wasmSysroot?: string } = {},
): Promise<BuildResult & { index?: number }> {
  const catalog = systemContracts(corePath);
  const contract = catalog.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!contract) {
    return { ok: false, stderr: `unknown system contract '${name}' — have: ${catalog.map((x) => x.name).join(", ")}` };
  }

  const result = await buildContract({
    contractPath: join(corePath, "src", "contracts", contract.file),
    name: contract.name,
    stateType: contract.stateType,
    slot: contract.index,
    corePath,
    outDir: opts.outDir ?? join(tmpdir(), "qinit-system"),
    skipVerify: true,
    wasmClang: opts.wasmClang,
    wasmSysroot: opts.wasmSysroot,
  });
  return { ...result, index: contract.index };
}
