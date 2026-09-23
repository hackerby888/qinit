import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, parse, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { cacheRoot } from "@qinit/core";
import { killNode, nodeAlive } from "./node";

// every name qinit writes directly under the cache root; a root showing none of them is somebody else's directory.
// current.json/downloads/tools: core/src/cache/paths.ts · wasi-sdk: cache/wasi-sdk.ts · run, active-node-scratch, node-index.json: ops/node.ts
// local: ops/node-core.ts headersVersion for a QINIT_CORE checkout · qinit-v*: a release version directory
const CACHE_ROOT_ENTRIES = ["current.json", "downloads", "tools", "wasi-sdk", "run", "active-node-scratch", "node-index.json", "local"];
const isCacheEntry = (name: string) => CACHE_ROOT_ENTRIES.includes(name) || /^qinit-v/.test(name);

// the cache root is created on demand, so a missing or empty one is fine; a populated one has to look like ours.
export function assertWipeableCacheRoot(root: string): void {
    const resolved = resolve(root);
    // the filesystem root, the home directory and the working directory, and anything above them, are never a cache whatever they hold.
    const sheltered = [parse(resolved).root, homedir(), process.cwd()];
    if (sheltered.some((dir) => resolved === dir || dir.startsWith(resolved + sep))) {
        throw new Error(`refusing to remove ${resolved}: it is the filesystem root, the home directory, or at or above the working directory`);
    }
    if (!existsSync(resolved)) {
        return;
    }

    const entries = readdirSync(resolved);
    if (entries.length && !entries.some(isCacheEntry)) {
        throw new Error(`refusing to remove ${resolved}: nothing of the qinit cache is there (${CACHE_ROOT_ENTRIES.join(", ")} or a qinit-v* release)`);
    }
}

export interface CacheItem {
    name: string;
    sz: number;
}

export interface CacheInfo {
    root: string;
    exists: boolean;
    items: CacheItem[];
    total: number;
}

export function dirSize(path: string): number {
    let size = 0;

    for (const entry of readdirSync(path, { withFileTypes: true })) {
        const entryPath = join(path, entry.name);
        try {
            size += entry.isDirectory() ? dirSize(entryPath) : statSync(entryPath).size;
        } catch {
            // Cache entries may disappear while they are being measured.
        }
    }

    return size;
}

export const human = (bytes: number): string => {
    if (bytes < 1024) {
        return bytes + "B";
    }
    if (bytes < 1048576) {
        return Math.round(bytes / 1024) + "KB";
    }
    return (bytes / 1048576).toFixed(1) + "MB";
};

export function cacheInfo(): CacheInfo {
    const root = cacheRoot();
    if (!existsSync(root)) {
        return { root, exists: false, items: [], total: 0 };
    }

    const items = readdirSync(root)
        .map((name) => {
            const path = join(root, name);
            let size = 0;

            try {
                size = statSync(path).isDirectory() ? dirSize(path) : statSync(path).size;
            } catch {
                // Cache entries may disappear while they are being measured.
            }

            return { name, sz: size };
        })
        .sort((left, right) => right.sz - left.sz);
    const total = items.reduce((sum, entry) => sum + entry.sz, 0);

    return { root, exists: true, items, total };
}

export async function wipeCache(): Promise<CacheInfo & { killed: boolean }> {
    const info = cacheInfo();
    assertWipeableCacheRoot(info.root);
    // nodeAlive also sees an untracked Qubic by image name, which killNode never touches; report what was actually stopped.
    const killed = nodeAlive() ? await killNode() : false;

    if (info.exists) {
        rmSync(info.root, { recursive: true, force: true });
    }

    return { ...info, killed };
}
