import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { hexToBytes, type LiteRpc } from "@qinit/core";

export const STATE_DUMP_DIR = "state";

export const STATE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

// `stateBytes` is the fast path; a node without the route (null) or an rpc without the method falls back to hex reads.
export type StateDumpRpc = Pick<LiteRpc, "stateRead"> & Partial<Pick<LiteRpc, "stateBytes">>;

export interface StateDumpResult {
    ok: true;
    slot: number;
    name: string;
    path: string;
    size: number;
}

export interface StateDumpOptions {
    out?: string;
    onProgress?: (writtenBytes: number, totalBytes: number) => void;
}

// The name comes from the node's registry, so this is also what stops a hostile one escaping the dump directory.
function dumpFileName(name: string, slot: number): string {
    const safe = name.trim().replace(/[^A-Za-z0-9._-]/g, "_");
    return `${safe || `slot-${slot}`}_dump.bin`;
}

function isDirectoryTarget(out: string): boolean {
    if (out.endsWith(sep) || out.endsWith("/")) {
        return true;
    }

    try {
        return statSync(out).isDirectory();
    } catch {
        return false;
    }
}

export function resolveDumpPath(name: string, slot: number, out?: string): string {
    const fileName = dumpFileName(name, slot);
    if (!out) {
        return resolve(STATE_DUMP_DIR, fileName);
    }
    return isDirectoryTarget(out) ? resolve(out, fileName) : resolve(out);
}

async function readStateHex(rpc: StateDumpRpc, slot: number, offset: number): Promise<{ bytes: Uint8Array; stateSize: number }> {
    const read = await rpc.stateRead(slot, offset, STATE_READ_CHUNK_BYTES);
    if (typeof read?.hex !== "string" || !Number.isSafeInteger(read.stateSize)) {
        throw new Error(`state read failed for slot ${slot}: ${JSON.stringify(read)}`);
    }

    return { bytes: hexToBytes(read.hex), stateSize: read.stateSize };
}

// Stream rather than buffer state images that can span hundreds of megabytes.
export async function dumpContractState(rpc: StateDumpRpc, slot: number, name: string, options: StateDumpOptions = {}): Promise<StateDumpResult> {
    const path = resolveDumpPath(name, slot, options.out);
    mkdirSync(dirname(path), { recursive: true });

    const file = openSync(path, "w");
    let written = 0;
    let total = 0;
    let raw = rpc.stateBytes !== undefined;

    try {
        do {
            const read = raw ? await rpc.stateBytes!(slot, written, STATE_READ_CHUNK_BYTES) : null;
            // An older node has no raw route; once it says so, the rest of the dump goes through hex reads.
            raw = read !== null;
            const { bytes: chunk, stateSize } = read ?? (await readStateHex(rpc, slot, written));

            total = stateSize;
            // The simulator answers for an unlisted slot with an empty state rather than an error, so an empty dump means no such contract.
            if (!total) {
                throw new Error(`slot ${slot} has no state — is a contract deployed there?`);
            }

            // Advance by what actually arrived: the response echoes the requested length even when short, and the node's state size can move between requests.
            if (!chunk.length && written < total) {
                throw new Error(`state read stalled at ${written} of ${total} bytes`);
            }

            writeSync(file, chunk);
            written += chunk.length;
            options.onProgress?.(written, total);
        } while (written < total);
    } catch (error) {
        closeSync(file);
        // A truncated dump must not pass for a complete one.
        rmSync(path, { force: true });
        throw error;
    }

    closeSync(file);
    return { ok: true, slot, name, path, size: written };
}
