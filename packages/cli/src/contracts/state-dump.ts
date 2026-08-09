import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { hexToBytes, type LiteRpc } from "@qinit/core";

export const STATE_DUMP_DIR = "state";

// The node clamps a single state-read to this, so asking for more only wastes the request.
const MAX_STATE_READ = 262144;

export type StateDumpRpc = Pick<LiteRpc, "stateRead">;

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

// The name comes from the node's registry, so this is also what stops a hostile one escaping the
// dump directory.
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

// Stream the state to disk rather than buffering it — an effective state runs to tens of megabytes.
export async function dumpContractState(
  rpc: StateDumpRpc,
  slot: number,
  name: string,
  options: StateDumpOptions = {},
): Promise<StateDumpResult> {
  const path = resolveDumpPath(name, slot, options.out);
  mkdirSync(dirname(path), { recursive: true });

  const file = openSync(path, "w");
  let written = 0;
  let total = 0;

  try {
    do {
      const read = await rpc.stateRead(slot, written, MAX_STATE_READ);
      if (typeof read?.hex !== "string" || !Number.isSafeInteger(read.stateSize)) {
        throw new Error(`state read failed for slot ${slot}: ${JSON.stringify(read)}`);
      }

      total = read.stateSize;
      // The simulator answers for an unlisted slot with an empty state rather than an error, so an
      // empty dump means no such contract — every deployed one carries a state struct.
      if (!total) {
        throw new Error(`slot ${slot} has no state — is a contract deployed there?`);
      }

      // Advance by what actually arrived: the response echoes the requested length even when its
      // slice came up short, and the node's state size can move between requests.
      const chunk = hexToBytes(read.hex);
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
