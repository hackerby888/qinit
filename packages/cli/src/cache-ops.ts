import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "@qinit/core";
import { killNode, nodeAlive } from "./node-ops";

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
      size += entry.isDirectory()
        ? dirSize(entryPath)
        : statSync(entryPath).size;
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
        size = statSync(path).isDirectory()
          ? dirSize(path)
          : statSync(path).size;
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
  let killed = false;

  if (nodeAlive()) {
    await killNode();
    killed = true;
  }

  if (info.exists) {
    rmSync(info.root, { recursive: true, force: true });
  }

  return { ...info, killed };
}
