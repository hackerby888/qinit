import type { ContractIdlFile } from "@qinit/proto/contract-idl";
import { contractIdlForSlot } from "../../contracts/idl-file";

export interface PlannedReuse {
    name: string;
    slot: number;
}

// why a slot the plan reuses cannot be taken, or null: a same-named contract another project deployed looks exactly like this project's last build, so only the project's own IDL record tells them apart.
// ponytail: the record is per project, not per node; after a chain reset another project can claim the slot unnoticed.
export function foreignSlotRejection(reused: readonly PlannedReuse[], file: ContractIdlFile, idlPath: string): string | null {
    const foreign = reused.find((contract) => !contractIdlForSlot(file, contract.slot));
    if (!foreign) {
        return null;
    }
    return `slot ${foreign.slot} already runs a '${foreign.name}' this project never deployed (no entry in ${idlPath}) — another project with the same contractName owns it; rename contractName in qinit.json, or pass --slot ${foreign.slot} to take the slot over`;
}
