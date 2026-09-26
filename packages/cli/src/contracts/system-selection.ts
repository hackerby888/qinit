// the simulator's system-contract selection lives in qinit.json; these keep it in step with what the node actually runs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DynamicContractRegistryEntry } from "@qinit/core";
import { scanCallees, type SystemContract } from "@qinit/build";
import type { ContractIdlFile } from "@qinit/proto/contract-idl";
import { contractIdlForSlot } from "./idl-file";

function writeSelection(path: string, create: boolean, update: (system: string[]) => string[]): boolean {
    if (!existsSync(path) && !create) {
        return false;
    }
    const cfg: Record<string, unknown> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    cfg.system = update(Array.isArray(cfg.system) ? (cfg.system as string[]) : []).sort();
    writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
    return true;
}

// false when there is no qinit.json to write: a deploy from a bare directory must not invent one.
export function addSystemSelection(names: readonly string[], path = "qinit.json", options: { create?: boolean } = {}): boolean {
    return writeSelection(path, options.create ?? false, (system) => [...new Set([...system, ...names])]);
}

export function removeSystemSelection(names: readonly string[], path = "qinit.json", options: { create?: boolean } = {}): boolean {
    const removed = new Set(names);
    return writeSelection(path, options.create ?? false, (system) => system.filter((name) => !removed.has(name)));
}

// JSC reserves a fixed region for fast wasm memories, and each system contract takes about a GiB of it.
export function describeDeployFailure(name: string, liveCount: number, error: unknown): string {
    const message = String((error as { message?: unknown })?.message ?? error);
    return /out of memory/i.test(message)
        ? `${name}: the simulator has no wasm memory left with ${liveCount} contracts loaded — restart it (qinit node stop && qinit node run) so it seeds them all, or add fewer`
        : `${name}: ${message}`;
}

export interface SystemDependent {
    name: string;
    index: number;
    uses: string;
}

// deployed user contracts that call one of the system contracts about to go: the idl file knows their callees, the source is the fallback for a slot it never recorded.
export function dependentsOf(
    removed: readonly SystemContract[],
    registry: readonly DynamicContractRegistryEntry[],
    idlFile: ContractIdlFile,
    catalog: readonly SystemContract[],
): SystemDependent[] {
    const systemSlots = new Set(catalog.map((contract) => contract.index));
    const removedNames = new Set(removed.flatMap((contract) => [contract.name, contract.stateType]));
    const catalogNames = catalog.flatMap((contract) => [contract.name, contract.stateType]);

    return registry
        .filter((entry) => entry.armed && !systemSlots.has(entry.index))
        .flatMap((entry) => {
            const idl = contractIdlForSlot(idlFile, entry.index, entry.codeHash);
            const callees = idl ? idl.dependencies : entry.source ? [...scanCallees(entry.source, { contractName: entry.name }, catalogNames)] : [];
            const uses = callees.filter((callee) => removedNames.has(callee));
            return uses.length ? [{ name: entry.name || String(entry.index), index: entry.index, uses: uses.join(", ") }] : [];
        });
}
