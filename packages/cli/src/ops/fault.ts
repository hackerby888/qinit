// A node that halted on a contract trap keeps answering reads, so every command that would otherwise
// report a stale tick has to ask for the fault and say so.
import { CONTRACT_ENTRY_KIND } from "@qinit/engine";
import { WASM_TRAP_ERROR_CODE, type EngineFaultInfo, type LiteRpc } from "@qinit/core";
import { loadContracts, mergeContracts } from "../contracts/registry";

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

// "abort(3422552174)" is how both runtimes spell a cheatcode abort; the hex form is what the developer
// reads a line number out of, so show both.
function withHexAbortCode(message: string): string {
    return message.replace(/abort\((\d+)\)/g, (whole, digits: string) => {
        const code = Number(digits);
        return Number.isSafeInteger(code) ? `abort(0x${code.toString(16).toUpperCase()})` : whole;
    });
}

const TRAP_CODE_TEXT = new RegExp(`abort\\(0x${WASM_TRAP_ERROR_CODE.toString(16).toUpperCase()}\\)|\\b${WASM_TRAP_ERROR_CODE}\\b`, "g");
// Core reports a function failure as the bare error code; a code in the assert range is a line number.
const BARE_ASSERT_CODE = /(smart contract function: )(\d+)$/;
const ASSERT_CODE_BASE = 0xcc000000;

/** A contract error line with its codes spelled the way a developer reads them. */
export function describeContractError(message: string): string {
    const named = message.replace(BARE_ASSERT_CODE, (whole, prefix: string, digits: string) => {
        const code = Number(digits);
        return code >= ASSERT_CODE_BASE && code <= ASSERT_CODE_BASE + 0xffffff ? `${prefix}abort(${code})` : whole;
    });
    return withHexAbortCode(named).replace(TRAP_CODE_TEXT, "wasm trap");
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

    return `node halted:${where}${entry} trapped ${describeContractError(fault.message)} at tick ${fault.failedTick} — run \`qinit node run\` to restart it`;
}
