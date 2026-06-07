// Unified contract discovery: user-deployed (dyn-registry) first, then built-in system contracts (catalog).
// Shared by call / ls / state so a name or index resolves the same everywhere.
import { LiteRpc, type DynContract } from "@qinit/core";
import { systemContracts, type SystemContract } from "@qinit/build";
import { layoutOf } from "@qinit/proto";
import { resolveCore } from "./config";

const fmtSize = (fmt?: string): number => { try { return fmt ? layoutOf(fmt).size : 0; } catch { return 0; } };

export type ContractSets = { user: DynContract[]; system: SystemContract[] };

// System catalog from the fetched snapshot; [] (never throws) if no snapshot / parse issue.
export function loadSystem(): SystemContract[] {
  try { return systemContracts(resolveCore()); } catch { return []; }
}

export async function loadContracts(rpc: LiteRpc): Promise<ContractSets> {
  let user: DynContract[] = [];
  try { user = ((await rpc.dynRegistry()).contracts ?? []).filter((c) => c.armed); } catch { /* node down -> system only */ }
  return { user, system: loadSystem() };
}

// Present a system contract as a DynContract so the existing picker/entry code (which reads c.functions /
// c.procedures + extractIdl(c.source)) works unchanged. Sizes are cosmetic for system entries (0).
export function systemAsDyn(c: SystemContract): DynContract {
  const entries = (tbl: Record<string, { in?: string; out?: string }>) =>
    Object.entries(tbl).map(([it, e]) => ({ inputType: Number(it), inputSize: fmtSize(e.in), outputSize: fmtSize(e.out) }));
  return {
    index: c.index, name: c.name, armed: true, constructed: true, version: 0, codeHash: "",
    functions: entries(c.idl.functions as any), procedures: entries(c.idl.procedures as any), source: c.source,
  };
}

export type Resolved = { index: number; name: string; kind: "user" | "system"; source?: string };
// Resolve a name-or-index across user (first) then system.
export function resolveContract(target: string, sets: ContractSets): Resolved | null {
  const low = target.trim().toLowerCase(); const asNum = Number(target);
  const u = sets.user.find((c) => c.index === asNum || (c.name || "").toLowerCase() === low);
  if (u) return { index: u.index, name: u.name || String(u.index), kind: "user", source: u.source };
  const s = sets.system.find((c) => c.index === asNum || c.name.toLowerCase() === low);
  if (s) return { index: s.index, name: s.name, kind: "system", source: s.source };
  return null;
}
