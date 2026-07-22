import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DynRegistry, DynContract } from "@qinit/core/rpc";
import { scanCallees, type DynCallees } from "@qinit/build/intercontract";
import { blankCommentsAndStrings } from "./lint/qpi-rules";

// Find callee references after blanking comments and strings while preserving source offsets.
export function findCalleeRefs(source: string): { name: string; offset: number; length: number }[] {
  const src = blankCommentsAndStrings(source);
  const out: { name: string; offset: number; length: number }[] = [];
  const re =
    /(?:CALL_OTHER_CONTRACT_FUNCTION|INVOKE_OTHER_CONTRACT_PROCEDURE)(?:_E)?\s*\(\s*(\w+)\s*,/dg;
  for (const m of src.matchAll(re)) {
    const [s, e] = m.indices![1];
    out.push({ name: m[1], offset: s, length: e - s });
  }
  return out;
}

// Report callees absent from both core definitions and the known dynamic registry.
export function unresolvedCalleeRefs(
  source: string,
  known: Set<string>,
): { name: string; offset: number; length: number }[] {
  return findCalleeRefs(source).filter((r) => !known.has(r.name));
}

// Dynamic callees need registry declarations because they are absent from contract_def.h.

// Write referenced registry headers to calleeDir and return their dynamic metadata.
export function calleesFromRegistry(
  source: string,
  contracts: DynContract[],
  calleeDir: string,
): DynCallees {
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
    const r = await fetch(`${rpcBase.replace(/\/+$/, "")}/live/v1/dyn-registry`, {
      signal: ctrl.signal,
    });
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
export async function dynCalleesFromNode(
  rpcBase: string,
  source: string,
  calleeDir: string,
): Promise<DynCallees> {
  if (scanCallees(source).size === 0) return {};
  return calleesFromRegistry(source, await fetchRegistry(rpcBase), calleeDir);
}
