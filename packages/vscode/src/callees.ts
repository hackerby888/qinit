import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DynRegistry, DynContract } from "@qinit/core/rpc";
import { scanCallees, type DynCallees } from "@qinit/build/intercontract";
import { blankCommentsAndStrings } from "./lint/qpi-rules";

// Position-aware callee references: each CALL_OTHER_CONTRACT_FUNCTION / INVOKE_OTHER_CONTRACT_PROCEDURE
// (+ _E) call and the offset of its callee-name token. Comments/strings are blanked first (offsets
// preserved) so a commented-out call isn't reported.
export function findCalleeRefs(source: string): { name: string; offset: number; length: number }[] {
  const src = blankCommentsAndStrings(source);
  const out: { name: string; offset: number; length: number }[] = [];
  const re = /(?:CALL_OTHER_CONTRACT_FUNCTION|INVOKE_OTHER_CONTRACT_PROCEDURE)(?:_E)?\s*\(\s*(\w+)\s*,/gd;
  for (const m of src.matchAll(re)) {
    const [s, e] = m.indices![1];
    out.push({ name: m[1], offset: s, length: e - s });
  }
  return out;
}

// Callee references that resolve to NEITHER an in-core contract (contract_def.h) nor a known dynamic
// (node-deployed) callee — they'll have no declarations in the editor TU, so clangd shows raw
// "undeclared identifier" errors. The caller turns these into one actionable diagnostic instead.
export function unresolvedCalleeRefs(source: string, known: Set<string>): { name: string; offset: number; length: number }[] {
  return findCalleeRefs(source).filter((r) => !known.has(r.name));
}

// Dynamic inter-contract resolution for the editor. A qinit-deployed contract that does
// CALL_OTHER_CONTRACT_*(Foo, …) needs Foo's declarations to parse. Foo isn't in core's contract_def.h
// (those are the built-in callees buildCalleePrelude already resolves) — but the node stores each
// deployed contract's .h source (POST /live/v1/dev/contract-source) and serves it back in the
// dyn-registry. So we fetch the registry, match it against the names this source calls, drop each
// match's source into a temp header, and hand buildCalleePrelude a DynCallees map — exactly how the
// node itself resolves callees, with no qinit.json/--callee config.

// Build the DynCallees map for the other-contract names `source` references from the node's registry
// contracts, writing each matched callee's stored .h to <calleeDir>/<Name>.h. Network-free (the caller
// supplies `contracts`); only writes under calleeDir. Returns {} when nothing matches.
export function calleesFromRegistry(source: string, contracts: DynContract[], calleeDir: string): DynCallees {
  const wanted = scanCallees(source);
  if (wanted.size === 0) return {};
  const out: DynCallees = {};
  for (const c of contracts) {
    if (!c || !c.name || !c.source || !wanted.has(c.name)) continue;
    mkdirSync(calleeDir, { recursive: true });
    const header = join(calleeDir, `${c.name}.h`);
    writeFileSync(header, c.source);
    out[c.name] = { header, index: c.index };
  }
  return out;
}

// Fast-fail registry read — a single GET with a short timeout and NO retry (unlike LiteRpc, whose
// boot-blip retry would hang the editor for ~30s when the node is down). On any failure: [].
async function fetchRegistry(rpcBase: string, timeoutMs = 1500): Promise<DynContract[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${rpcBase.replace(/\/+$/, "")}/live/v1/dyn-registry`, { signal: ctrl.signal });
    if (!r.ok) return [];
    return ((await r.json()) as DynRegistry)?.contracts ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Best-effort: if this contract calls others, resolve those callees from the running node's stored
// sources. {} when there are no callees (no network touched) or the node is unreachable (no error).
export async function dynCalleesFromNode(rpcBase: string, source: string, calleeDir: string): Promise<DynCallees> {
  if (scanCallees(source).size === 0) return {};
  return calleesFromRegistry(source, await fetchRegistry(rpcBase), calleeDir);
}
