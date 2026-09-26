import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { LiteRpc } from "@qinit/core";
import { invalidArgs } from "../args";

// under the smallest request-body cap of the two node runtimes (1 MiB), so neither needs its limit raised
export const STATE_STAGE_CHUNK_BYTES = 512 * 1024;

export type StateStageRpc = Pick<LiteRpc, "stageState">;

// `--state <path>` names the main contract, `--state Name=<path>` any contract of the deployment.
export function parseInitialStates(values: readonly string[] | undefined, mainName?: string): Record<string, string> {
    const statePaths = new Map<string, string>();

    for (const value of values ?? []) {
        const match = /^([A-Za-z_]\w*)=(.+)$/.exec(value);
        const name = match?.[1] ?? mainName;
        if (name === undefined) {
            invalidArgs(`invalid --state '${value}': expected Name=path`);
        }
        if (statePaths.has(name)) {
            invalidArgs(`duplicate --state for '${name}'`);
        }

        const statePath = resolve(match?.[2] ?? value);
        if (!statSync(statePath, { throwIfNoEntry: false })?.isFile()) {
            invalidArgs(`--state file not found: ${statePath}`);
        }

        statePaths.set(name, statePath);
    }

    return Object.fromEntries(statePaths);
}

// stream the file in chunks rather than buffer state images that can span hundreds of megabytes.
export async function stageContractState(rpc: StateStageRpc, slot: number, statePath: string): Promise<number> {
    const totalBytes = statSync(statePath).size;
    if (totalBytes === 0) {
        throw new Error(`state file is empty: ${statePath}`);
    }

    const file = openSync(statePath, "r");
    const chunk = Buffer.alloc(Math.min(STATE_STAGE_CHUNK_BYTES, totalBytes));

    try {
        for (let offset = 0; offset < totalBytes;) {
            const readBytes = readSync(file, chunk, 0, chunk.length, offset);
            if (readBytes <= 0) {
                throw new Error(`state file ended at ${offset} of ${totalBytes} B: ${statePath}`);
            }

            const staged = await rpc.stageState(slot, offset, totalBytes, chunk.subarray(0, readBytes));
            if (!staged) {
                throw new Error("node does not support --state; update the node");
            }

            offset += readBytes;
        }
    } finally {
        closeSync(file);
    }

    return totalBytes;
}

// best effort: a staged state nobody deploys would otherwise seed the slot's next deploy.
export async function clearStagedState(rpc: StateStageRpc, slot: number): Promise<void> {
    try {
        await rpc.stageState(slot, 0, 0, new Uint8Array(0));
    } catch {
        // the node is gone or never had the route; nothing is left staged either way
    }
}
