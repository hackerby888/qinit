import { extractIdl, type ContractIdl } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import type { LiteRpc } from "@qinit/core";
import { contractIdlForSlot, loadContractIdlFile } from "../../contracts/idl-file";
import { siblingCalleeSources } from "../../contracts/registry";

// The IDL of what the slot holds now: the local record when it describes the deployed code, else one derived from the node's source. Undefined when neither.
export async function deployedStateIdl(rpc: LiteRpc, slot: number, corePath: string, idlPath?: string): Promise<ContractIdl | undefined> {
    const contracts = (await rpc.dynRegistry()).contracts ?? [];
    const occupant = contracts.find((contract) => contract.index === slot && contract.armed);
    if (!occupant) {
        return undefined;
    }

    try {
        const local = contractIdlForSlot(loadContractIdlFile(idlPath), slot, occupant.codeHash);
        if (local) {
            return local;
        }
    } catch {
        // An unreadable IDL file is not a reason to skip the check; the node's source is the fallback.
    }

    if (!occupant.source) {
        return undefined;
    }
    try {
        return extractIdl(occupant.source, occupant.name || String(slot), {
            slot,
            qpiHeader: loadQpiHeader(corePath),
            calleeSources: siblingCalleeSources(contracts, slot),
        });
    } catch {
        return undefined;
    }
}

// Why a redeploy of `next` over `previous` must not proceed, or null when the bytes stay readable: a changed layout with no MIGRATE handler is reinterpreted.
export function stateCarryoverRejection(name: string, previous: ContractIdl, next: ContractIdl): string | null {
    const before = previous.state;
    const after = next.state;
    if (!before || !after) {
        return null;
    }
    if (before.size === after.size && before.format === after.format) {
        return null;
    }
    if (next.migration) {
        return null;
    }

    return (
        `state layout changed — was ${before.size} B (${before.format || "empty"}), now ${after.size} B (${after.format || "empty"}) — ` +
        `and ${name} has no MIGRATE handler, so the old state bytes would be reinterpreted under the new offsets. ` +
        "Add a MIGRATE handler, restart the node for a clean slot, or pass --allow-state-carryover to keep the bytes as they are."
    );
}
