// Cache layout on disk: ~/.cache/qinit/<version>/core-headers/ (+ node/Qubic), pointer at current.json.
// Node-only (no Bun APIs) — project.ts re-exports from here for consumers that must stay Bun-free.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWrite } from "./download";

export function cacheRoot(): string {
    return process.env.QINIT_CACHE ?? join(homedir(), ".cache", "qinit");
}
export function cacheDir(version: string): string {
    return join(cacheRoot(), version);
}
export function cacheHeaders(version: string): string {
    return join(cacheDir(version), "core-headers");
}
export function toolsDir(): string {
    return join(cacheRoot(), "tools");
}

// e.g. linux-x64, darwin-arm64, windows-x64 — the manifest key for this host.
export function releasePlatformKey(): string {
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
    const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
    return `${os}-${arch}`;
}

// Track header and node versions separately so updating one never clobbers the other.
export interface CurrentPointer {
    headersVersion?: string;
    coreHeaders?: string;
    nodeVersion?: string;
    node?: string;
    verify?: string; // path to the cached contractverify tool
    verifySha?: string; // drives auto-update
    verifyVersion?: string; // upstream image digest / version it was built from
    verifyCheckedAt?: string; // daily-cached gate
    syncedAt?: string;
}
export function currentPath(): string {
    return join(cacheRoot(), "current.json");
}
export function readCurrent(): CurrentPointer | null {
    try {
        return JSON.parse(readFileSync(currentPath(), "utf8")) as CurrentPointer;
    } catch {
        return null;
    }
}
// Merge-write: updating headers preserves node info (and vice versa).
export function updateCurrent(patch: Partial<CurrentPointer>): CurrentPointer {
    const next = { ...(readCurrent() ?? {}), ...patch, syncedAt: new Date().toISOString() };
    mkdirSync(cacheRoot(), { recursive: true });
    atomicWrite(currentPath(), JSON.stringify(next, null, 2));
    return next;
}
