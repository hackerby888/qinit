// A node that halted on a contract trap keeps answering reads, so every command that would report a stale tick has to ask for the fault and say so.
import { CONTRACT_ENTRY_KIND } from "@qinit/engine";
import { describeContractError, type EngineFaultInfo, type LiteRpc } from "@qinit/core";
import { loadContracts, mergeContracts } from "../contracts/registry";

export { describeContractError };

const ENTRY_LABEL: Record<number, string> = {
    [CONTRACT_ENTRY_KIND.FUNCTION]: "fn",
    [CONTRACT_ENTRY_KIND.PROCEDURE]: "proc",
    [CONTRACT_ENTRY_KIND.SYSPROC]: "sysproc",
    [CONTRACT_ENTRY_KIND.MIGRATE]: "migrate",
};

/** The fault route, or null when the node is healthy or too old to serve it. */
export async function readFault(rpc: Pick<LiteRpc, "faultInfo">): Promise<EngineFaultInfo | null> {
    try {
        return await rpc.faultInfo();
    } catch (error) {
        // A missing route means an older node; anything else is a real failure worth reporting.
        if ((error as { status?: number }).status === 404) {
            return null;
        }
        throw error;
    }
}

/** The fault line with the slot resolved to a contract name, when the registry still answers. */
export async function describeFault(rpc: LiteRpc, fault: EngineFaultInfo): Promise<string> {
    let name: string | undefined;
    if (fault.slot !== undefined) {
        const { all } = mergeContracts(await loadContracts(rpc));
        name = all.find((contract) => contract.index === fault.slot)?.name || undefined;
    }

    return formatFault(fault, name);
}

/** One line naming what trapped, where, and how to recover. */
export function formatFault(fault: EngineFaultInfo, contractName?: string): string {
    const where = fault.slot === undefined ? "" : ` ${contractName ?? `slot ${fault.slot}`}`;
    const entry = fault.entry === undefined ? "" : ` ${ENTRY_LABEL[fault.kind ?? -1] ?? "entry"}#${fault.entry}`;

    // the transaction is the identifier a developer needs at the moment a node halts; both runtimes carry it.
    const tx = fault.txId ? ` (tx ${fault.txId})` : "";

    return `node halted:${where}${entry} trapped ${describeContractError(fault.message)} at tick ${fault.failedTick}${tx} — run \`qinit node run\` to restart it`;
}
