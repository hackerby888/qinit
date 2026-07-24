import { LiteRpc, debug, type DynContract } from "@qinit/core";
import { systemContracts, type SystemContract } from "@qinit/build";
import type { ContractEntry } from "@qinit/proto/contract-idl";
import { resolveCore } from "./config";

export type ContractSets = { user: DynContract[]; system: SystemContract[] };

export function loadSystem(): SystemContract[] {
  let core: string;

  try {
    core = resolveCore();
  } catch {
    return [];
  }

  try {
    return systemContracts(core);
  } catch (error) {
    debug("loadSystem: system catalog parse failed", error);
    return [];
  }
}

export async function loadContracts(rpc: LiteRpc): Promise<ContractSets> {
  let user: DynContract[] = [];

  try {
    user = ((await rpc.dynRegistry()).contracts ?? []).filter(
      (contract) => contract.armed,
    );
  } catch {
    // System contracts remain available while the node is down.
  }

  return { user, system: loadSystem() };
}

export function systemAsDyn(contract: SystemContract): DynContract {
  const entries = (items: ContractEntry[]) =>
    items.map((entry) => ({
      inputType: entry.inputType,
      inputSize: entry.inSize,
      outputSize: entry.outSize,
    }));

  return {
    index: contract.index,
    name: contract.name,
    armed: true,
    constructed: true,
    version: 0,
    codeHash: "",
    functions: entries(contract.idl.functions),
    procedures: entries(contract.idl.procedures),
    source: contract.source,
  };
}

export type Resolved = {
  index: number;
  name: string;
  kind: "user" | "system";
  source?: string;
  codeHash?: string;
};

export function resolveContract(
  target: string,
  sets: ContractSets,
): Resolved | null {
  const normalized = target.trim().toLowerCase();
  const index = Number(target);
  const userContract = sets.user.find(
    (contract) =>
      contract.index === index ||
      (contract.name || "").toLowerCase() === normalized,
  );

  if (userContract) {
    return {
      index: userContract.index,
      name: userContract.name || String(userContract.index),
      kind: "user",
      source: userContract.source,
      ...(userContract.codeHash ? { codeHash: userContract.codeHash } : {}),
    };
  }

  const systemContract = sets.system.find(
    (contract) =>
      contract.index === index ||
      contract.name.toLowerCase() === normalized,
  );
  if (systemContract) {
    return {
      index: systemContract.index,
      name: systemContract.name,
      kind: "system",
      source: systemContract.source,
    };
  }

  return null;
}
