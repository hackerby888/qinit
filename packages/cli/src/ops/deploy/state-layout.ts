import { extractIdl, type ContractIdl } from "@qinit/build";
import { loadQpiHeader } from "@qinit/compiler";
import type { LiteRpc } from "@qinit/core";
import { contractIdlForSlot, loadContractIdlFile } from "../../contracts/idl-file";
import { siblingCalleeSources } from "../../contracts/registry";

export { stateCarryoverRejection } from "@qinit/proto";

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

// why a state file cannot seed `next`, or null when it fits: the node takes exactly the new StateData size, or the OldStateData size a MIGRATE handler reads.
export function initialStateRejection(name: string, fileBytes: number, next: ContractIdl): string | null {
    const stateBytes = next.state?.size;
    if (stateBytes === undefined || fileBytes === stateBytes) {
        return null;
    }

    const migrateBytes = next.migration?.oldState.size;
    if (fileBytes === migrateBytes) {
        return null;
    }

    const accepted = migrateBytes === undefined ? `${stateBytes} B` : `${stateBytes} B, or ${migrateBytes} B for its MIGRATE handler`;
    return `state file is ${fileBytes} B but ${name}'s StateData is ${accepted}`;
}
