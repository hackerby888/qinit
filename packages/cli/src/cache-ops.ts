// Shared qinit cache helpers (cacheRoot = ~/.cache/qinit or $QINIT_CACHE): fetched node, core-headers snapshot,
// wasi-sdk, verify tools, scratch run dir. Used by `qinit clean` and `qinit uninstall`.
import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "@qinit/core";
import { killNode, nodeAlive } from "./node-ops";

export interface CacheItem { name: string; sz: number }
export interface CacheInfo { root: string; exists: boolean; items: CacheItem[]; total: number }

export function dirSize(p: string): number {
  let s = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const fp = join(p, e.name);
    try { s += e.isDirectory() ? dirSize(fp) : statSync(fp).size; } catch {}
  }
  return s;
}

export const human = (n: number) => (n < 1024 ? n + "B" : n < 1048576 ? Math.round(n / 1024) + "KB" : (n / 1048576).toFixed(1) + "MB");

// Scan the cache: per-entry sizes (sorted desc) + total. exists=false when there's no cache dir.
export function cacheInfo(): CacheInfo {
  const root = cacheRoot();
  if (!existsSync(root)) return { root, exists: false, items: [], total: 0 };
  const items = readdirSync(root).map((name) => {
    const p = join(root, name);
    let sz = 0; try { sz = statSync(p).isDirectory() ? dirSize(p) : statSync(p).size; } catch {}
    return { name, sz };
  }).sort((a, b) => b.sz - a.sz);
  return { root, exists: true, items, total: items.reduce((a, e) => a + e.sz, 0) };
}

// Stop a running node (it holds locks under <cache>/run), then remove the whole cache. Returns the pre-wipe info.
export async function wipeCache(): Promise<CacheInfo & { killed: boolean }> {
  const info = cacheInfo();
  let killed = false;
  if (nodeAlive()) { await killNode(); killed = true; }
  if (info.exists) rmSync(info.root, { recursive: true, force: true });
  return { ...info, killed };
}
