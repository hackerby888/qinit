// qinit build: contract .h -> .so + K12 hash + undefined-QPI-symbol report.
// The undefined-symbol list drives which QpiContext forwarders lite_dyn_abi.h still needs.
import { statSync, readFileSync } from "node:fs";
import { compile, compileWasmContract, type BuildOpts } from "./recipe";
import { compileWasm, haveWasmToolchain, toolchainDir } from "./wasm-toolchain";
import { extractIdl, type ContractIdl } from "./idl";
import { buildCalleePrelude } from "./intercontract";
import { verifyContract, type VerifyResult } from "./verify";
import { k12Hex } from "@qinit/core";

export { compileWasm, haveWasmToolchain, toolchainDir } from "./wasm-toolchain";

export type { BuildOpts } from "./recipe";
export { extractIdl } from "./idl";
export type { ContractIdl, IdlEntry, Field } from "./idl";
export { generateClient } from "./gen-client";
export { testRuntimeSource, sampleTest } from "./gen-test";
export { buildSnapshot } from "./snapshot";
export type { SnapshotResult } from "./snapshot";
export { verifyContract, resolveVerifyTool } from "./verify";
export type { VerifyResult } from "./verify";

export interface BuildResult {
  ok: boolean;
  so?: string;
  size?: number;
  hash?: string;
  undef?: string[];
  idl?: ContractIdl;
  verify?: VerifyResult;
  stderr?: string;
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
  const verify = await verifyContract(o.contractPath, o.name, { allowedPrefixes: calleeNames });
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
  // target=wasm: compile the contract TO a wasm module (run by the node's WAMR engine) instead of a native
  // .so/.dylib. One platform-independent artifact; deployed down the same chunked-upload path (the node
  // magic-sniffs '\0asm' -> wasm engine). See core WASM_CONTRACTS.md §13.11.
  if (o.target === "wasm") {
    const w = await compileWasmContract({ ...o, calleePrelude });
    if (!w.ok) return { ok: false, so: w.wasm, stderr: w.stderr };
    const wsize = statSync(w.wasm).size;
    let whash: string | undefined;
    try { whash = await k12Hex(new Uint8Array(readFileSync(w.wasm))); } catch { whash = undefined; }
    let widl: ContractIdl | undefined;
    try { widl = extractIdl(readFileSync(o.contractPath, "utf8"), o.name); } catch { widl = undefined; }
    return { ok: true, so: w.wasm, size: wsize, hash: whash, idl: widl, verify };
  }

  // Backend: wasm (bundled clang.wasm — zero native dep) or native clang. auto = wasm if cached.
  const useWasm = o.toolchain === "wasm" || (o.toolchain !== "native" && o.toolchain === "auto" && haveWasmToolchain());
  const c = useWasm ? await compileWasm({ ...o, calleePrelude }) : await compile({ ...o, calleePrelude });
  if (!c.ok) return { ok: false, so: c.so, stderr: c.stderr };
  const size = statSync(c.so).size;
  let hash: string | undefined;
  try {
    hash = await k12Hex(new Uint8Array(readFileSync(c.so)));
  } catch {
    // Works in dev; pending in the --compile binary (the libFourQ_K12 wasm inits
    // QubicHelper's crypto instance, not a second direct import). Fix in M2 (deploy
    // needs the hash) — likely route K12 through the helper's instance or vendor KT128.
    hash = undefined;
  }
  const undef = await undefinedQpiSymbols(c.so);
  let idl: ContractIdl | undefined;
  try { idl = extractIdl(readFileSync(o.contractPath, "utf8"), o.name); } catch { idl = undefined; }
  return { ok: true, so: c.so, size, hash, undef, idl, verify };
}

// Symbols the .so leaves unresolved that the host/ABI must provide — anything dlopen RTLD_NOW
// would fail on. Report ALL undefined except the C++/libc runtime (resolved at load by libstdc++).
// (Earlier a narrow QPI-only filter silently missed `bs` and `setMem` -> dlopen failed at runtime.)
async function undefinedQpiSymbols(so: string): Promise<string[]> {
  const p = Bun.spawn(["nm", "-D", "-u", "-C", so], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const runtime = /(@GLIBC|@CXXABI|@GCC|_ITM_|__gmon_start__|__cxa_|__gxx_personality|_Unwind_|std::|operator new|operator delete)/;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("U ") && !runtime.test(l))
    .map((l) => l.slice(2).trim());
}
