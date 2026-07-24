// Unified contract discovery: user-deployed (dyn-registry) first, then built-in system contracts (catalog).
// Shared by call / ls / state so a name or index resolves the same everywhere.
import { LiteRpc, debug, type DynContract } from "@qinit/core";
import { systemContracts, type SystemContract } from "@qinit/build";
import type { ContractEntry } from "@qinit/proto/contract-idl";
import { resolveCore } from "./config";

export type ContractSets = { user: DynContract[]; system: SystemContract[] };

// System catalog from the fetched snapshot; [] (never throws). No snapshot = benign (user contracts still
// resolve); a snapshot that's present but fails to parse is a real issue -> debug-log the cause, not silent.
export function loadSystem(): SystemContract[] {
  let core: string;
  try {
    core = resolveCore();
  } catch {
    return [];
  } // no snapshot yet
  try {
    return systemContracts(core);
  } catch (e: any) {
    debug("loadSystem: system catalog parse failed", e);
    return [];
  }
}

export async function loadContracts(rpc: LiteRpc): Promise<ContractSets> {
  let user: DynContract[] = [];
  try {
    user = ((await rpc.dynRegistry()).contracts ?? []).filter((c) => c.armed);
  } catch {
    /* node down -> system only */
  }
  return { user, system: loadSystem() };
}

// Present a system contract as a DynContract so registry and system entries share one picker path.
export function systemAsDyn(c: SystemContract): DynContract {
  const entries = (items: ContractEntry[]) =>
    items.map((entry) => ({
      inputType: entry.inputType,
      inputSize: entry.inSize,
      outputSize: entry.outSize,
    }));
  return {
    index: c.index,
    name: c.name,
    armed: true,
    constructed: true,
    version: 0,
    codeHash: "",
    functions: entries(c.idl.functions),
    procedures: entries(c.idl.procedures),
    source: c.source,
  };
}

export type Resolved = {
  index: number;
  name: string;
  kind: "user" | "system";
  source?: string;
  codeHash?: string;
};
// Resolve a name-or-index across user (first) then system.
export function resolveContract(target: string, sets: ContractSets): Resolved | null {
  const low = target.trim().toLowerCase();
  const asNum = Number(target);
  const u = sets.user.find((c) => c.index === asNum || (c.name || "").toLowerCase() === low);
  if (u) {
    return {
      index: u.index,
      name: u.name || String(u.index),
      kind: "user",
      source: u.source,
      ...(u.codeHash ? { codeHash: u.codeHash } : {}),
    };
  }
  const s = sets.system.find((c) => c.index === asNum || c.name.toLowerCase() === low);
  if (s) return { index: s.index, name: s.name, kind: "system", source: s.source };
  return null;
}
