// qinit build: contract .h -> wasm module (run by the node's WAMR engine) + K12 hash + IDL.
import { statSync, readFileSync } from "node:fs";
import { compileWasmContract, type BuildOpts } from "./recipe";
import { extractIdl, type ContractIdl } from "./idl";
import { buildCalleePrelude } from "./intercontract";
import { verifyContract, type VerifyResult } from "./verify";
import { k12Hex } from "@qinit/core";

export type { BuildOpts } from "./recipe";
export { extractIdl } from "./idl";
export type { ContractIdl, IdlEntry, Field, LogStruct, EnumDef } from "./idl";
export { systemContracts, systemNames, type SystemContract } from "./system-contracts";
export { generateClient } from "./gen-client";
export { testRuntimeSource, sampleTest } from "./gen-test";
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
    try { calleePrelude = buildCalleePrelude(o.corePath, readFileSync(o.contractPath, "utf8"), o.dynCallees ?? {}); }
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
  try { idl = extractIdl(readFileSync(o.contractPath, "utf8"), o.name); } catch (e: any) { idlError = String(e?.message ?? e); }
  return { ok: true, so: w.wasm, size, hash, idl, idlError, verify, debugWasm: w.debugWasm, linesJson: w.linesJson };
}
