// Cache + fetch + verify for synced assets (core-header snapshot now; prebuilt node later).
// Cache layout: ~/.cache/qinit/<version>/core-headers/ (+ node/Qubic), pointer at current.json.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Release source = the user's fork. NEVER qubic/core-lite (upstream) — see project memory.
export const RELEASE_REPO = "hackerby888/core-lite";

export function cacheRoot(): string {
  return process.env.QINIT_CACHE ?? join(homedir(), ".cache", "qinit");
}
export function cacheDir(version: string): string {
  return join(cacheRoot(), version);
}
export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface AssetRef { url: string; sha256: string; }
export interface Manifest { version: string; node?: AssetRef; headers?: AssetRef; }

// Pull the release manifest that pins {node, headers} for one version (ABI-consistent set).
export async function loadManifest(ref = "latest", repo = RELEASE_REPO): Promise<Manifest> {
  const path = ref === "latest" ? "latest/download" : `download/${ref}`;
  const url = `https://github.com/${repo}/releases/${path}/qinit-manifest.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`manifest fetch failed (HTTP ${r.status}) from ${url}`);
  return (await r.json()) as Manifest;
}

// Download an asset and verify its sha256 (mismatch => throw, never cache a bad blob).
// onProgress(received, total) streams download bytes for a live progress bar.
export async function fetchVerify(asset: AssetRef, onProgress?: (recv: number, total: number) => void): Promise<Uint8Array> {
  const r = await fetch(asset.url);
  if (!r.ok) throw new Error(`download failed (HTTP ${r.status}): ${asset.url}`);
  let buf: Uint8Array;
  if (onProgress && r.body) {
    const total = Number(r.headers.get("content-length") ?? 0);
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let recv = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); recv += value.length; onProgress(recv, total); }
    buf = new Uint8Array(recv);
    let off = 0; for (const p of parts) { buf.set(p, off); off += p.length; }
  } else {
    buf = new Uint8Array(await r.arrayBuffer());
  }
  if (asset.sha256) {
    const got = sha256Hex(buf);
    if (got !== asset.sha256) throw new Error(`sha256 mismatch for ${asset.url}\n  want ${asset.sha256}\n  got  ${got}`);
  }
  return buf;
}

// Extract a .tar.gz buffer into destDir (system tar; gzip is universal — no zstd dep).
export async function extractTarGz(tarGz: Uint8Array, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const p = Bun.spawn(["tar", "xzf", "-", "-C", destDir], { stdin: tarGz, stdout: "pipe", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  await p.exited;
  if (p.exitCode !== 0) throw new Error("tar extract failed: " + err);
}

// current.json — headers vs node tracked with SEPARATE versions so one update never clobbers
// the other's version (prevents node/headers drift, which would mean building against headers
// that don't match the running node = silent ABI mismatch).
export interface CurrentPointer {
  headersVersion?: string; coreHeaders?: string;
  nodeVersion?: string; node?: string;
  verify?: string; // path to the cached contractverify tool
  syncedAt?: string;
}
export function currentPath(): string { return join(cacheRoot(), "current.json"); }
export function readCurrent(): CurrentPointer | null {
  try { return JSON.parse(readFileSync(currentPath(), "utf8")) as CurrentPointer; } catch { return null; }
}
// Merge-write: updating headers preserves node info (and vice versa).
export function updateCurrent(patch: Partial<CurrentPointer>): CurrentPointer {
  const next = { ...(readCurrent() ?? {}), ...patch, syncedAt: new Date().toISOString() };
  mkdirSync(cacheRoot(), { recursive: true });
  writeFileSync(currentPath(), JSON.stringify(next, null, 2));
  return next;
}
export function cacheHeaders(version: string): string { return join(cacheDir(version), "core-headers"); }
