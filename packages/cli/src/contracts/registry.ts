import { LiteRpc, debug, type DynamicContractRegistryEntry } from "@qinit/core";
import { systemContracts, type SystemContract } from "@qinit/build";
import { MAX_NUMBER_OF_CONTRACTS } from "@qinit/proto";
import type { ContractEntry } from "@qinit/proto/contract-idl";
import { resolveCoreDir } from "../config";

export type ContractSets = {
    user: DynamicContractRegistryEntry[];
    system: SystemContract[];
};

export function parseContractSlot(value: unknown): number {
    const slot = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isInteger(slot) || slot < 1 || slot >= MAX_NUMBER_OF_CONTRACTS) {
        throw new Error(`contract slot must be an integer from 1 to ${MAX_NUMBER_OF_CONTRACTS - 1}`);
    }
    return slot;
}

export function loadSystem(): SystemContract[] {
    let core: string;

    try {
        core = resolveCoreDir();
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
    let user: DynamicContractRegistryEntry[] = [];

    try {
        user = ((await rpc.dynRegistry()).contracts ?? []).filter((contract) => contract.armed);
    } catch {
        // System contracts remain available while the node is down.
    }

    return { user, system: loadSystem() };
}

export function systemAsDyn(contract: SystemContract): DynamicContractRegistryEntry {
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

// A deployed system contract sits in both the node's dyn registry and the catalog under one slot, and the
// node holds no .h for it. Merge on index so each slot appears once, taking source from the catalog.
export function mergeContracts(sets: ContractSets): {
    all: DynamicContractRegistryEntry[];
    userCount: number;
} {
    const catalog = new Map(sets.system.map((contract) => [contract.index, contract]));
    const user = sets.user.map((contract) => (contract.source ? contract : { ...contract, source: catalog.get(contract.index)?.source }));
    const deployed = new Set(user.map((contract) => contract.index));
    const system = sets.system.filter((contract) => !deployed.has(contract.index)).map(systemAsDyn);

    return { all: [...user, ...system], userCount: user.length };
}

export type ResolvedContract = {
    index: number;
    name: string;
    kind: "user" | "system";
    source?: string;
    codeHash?: string;
};

export function resolveContract(target: string, sets: ContractSets): ResolvedContract | null {
    const normalized = target.trim().toLowerCase();
    const index = Number(target);
    const userContract = sets.user.find((contract) => contract.index === index || (contract.name || "").toLowerCase() === normalized);

    if (userContract) {
        const catalogEntry = sets.system.find((contract) => contract.index === userContract.index);
        return {
            index: userContract.index,
            name: userContract.name || String(userContract.index),
            kind: "user",
            source: userContract.source || catalogEntry?.source,
            ...(userContract.codeHash ? { codeHash: userContract.codeHash } : {}),
        };
    }

    const systemContract = sets.system.find((contract) => contract.index === index || contract.name.toLowerCase() === normalized);
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
