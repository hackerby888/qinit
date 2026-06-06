// Cache + fetch + verify for synced assets (core-header snapshot now; prebuilt node later).
// Cache layout: ~/.cache/qinit/<version>/core-headers/ (+ node/Qubic), pointer at current.json.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
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
// node = back-compat (linux-x64); nodes = per-platform map keyed by verifyPlatformKey() (linux-x64, linux-arm64, …)
export interface Manifest { version: string; node?: AssetRef; nodes?: Record<string, AssetRef>; headers?: AssetRef; }

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
  verify?: string;          // path to the cached contractverify tool
  verifySha?: string;       // sha256 of the cached tool (drives auto-update)
  verifyVersion?: string;   // upstream image digest / version it was built from
  verifyCheckedAt?: string; // last time we checked the manifest (daily-cached gate)
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

// ---- contractverify tool distribution + auto-update --------------------------
// The verify tool ships in its own moving release (re-published when upstream changes), so it
// updates independently of the node/headers version set. version = upstream image digest.
export const VERIFY_REPO = "hackerby888/qinit";
export const VERIFY_TAG = "verify-latest";
export interface VerifyManifest { version: string; assets: Record<string, AssetRef>; }

export function toolsDir(): string { return join(cacheRoot(), "tools"); }
export function cachedVerifyToolPath(): string {
  return join(toolsDir(), process.platform === "win32" ? "contractverify.exe" : "contractverify");
}
// e.g. linux-x64, darwin-arm64, windows-x64 — the manifest key for this host.
export function verifyPlatformKey(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  return `${os}-${arch}`;
}
export async function loadVerifyManifest(repo = VERIFY_REPO): Promise<VerifyManifest> {
  const url = `https://github.com/${repo}/releases/download/${VERIFY_TAG}/verify-manifest.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`verify manifest fetch failed (HTTP ${r.status})`);
  return (await r.json()) as VerifyManifest;
}

export interface VerifyUpdate { action: "none" | "installed" | "updated" | "current" | "offline" | "unsupported"; version?: string; }
// Daily-cached, best-effort, never throws. Compares the published sha256 to the cached tool's and
// pulls when newer. `force` ignores the age gate (used by `qinit sync`). Offline/unreachable = no-op.
export async function autoUpdateVerifyTool(opts?: { force?: boolean; maxAgeMs?: number }): Promise<VerifyUpdate> {
  if (process.env.QINIT_NO_UPDATE) return { action: "none" };
  const cur = readCurrent() ?? {};
  const maxAge = opts?.maxAgeMs ?? 24 * 3600 * 1000;
  const last = cur.verifyCheckedAt ? Date.parse(cur.verifyCheckedAt) : 0;
  if (!opts?.force && Date.now() - last < maxAge) return { action: "none" };

  let m: VerifyManifest;
  try { m = await loadVerifyManifest(); } catch { return { action: "offline" }; }
  const asset = m.assets[verifyPlatformKey()];
  if (!asset) { updateCurrent({ verifyCheckedAt: new Date().toISOString() }); return { action: "unsupported" }; }

  const tool = cachedVerifyToolPath();
  const have = existsSync(tool);
  if (have && cur.verifySha === asset.sha256) {
    updateCurrent({ verifyCheckedAt: new Date().toISOString() });
    return { action: "current", version: m.version };
  }
  try {
    const buf = await fetchVerify(asset);
    mkdirSync(toolsDir(), { recursive: true });
    writeFileSync(tool, buf);
    Bun.spawnSync(["chmod", "+x", tool]);
    updateCurrent({ verify: tool, verifySha: asset.sha256, verifyVersion: m.version, verifyCheckedAt: new Date().toISOString() });
    return { action: have ? "updated" : "installed", version: m.version };
  } catch { return { action: "offline" }; }
}

// ---- wasi-sdk (clang + wasi-sysroot for `qinit build`) ------------------------------------------
// Pinned to 29 (33 declares getrusage, breaking the toolchain's config assumptions). Upstream ships
// prebuilts for every host (linux/macos/windows x x64/arm64), so we fetch the one matching this box.
// The wasm CONTRACT artifact is OS-independent — only the COMPILER is per-host, hence a per-host download.
const WASI_SDK_VER = "29";
function wasiSdkAsset(): { url: string; base: string } {
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const base = `wasi-sdk-${WASI_SDK_VER}.0-${arch}-${os}`;
  return { url: `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VER}/${base}.tar.gz`, base };
}
export function wasiSdkDir(): string { return join(cacheRoot(), "wasi-sdk"); }
// Resolve clang++ + wasi-sysroot inside the cached sdk (the tarball keeps a nested top dir, so scan one level).
export function wasiSdkPaths(): { root: string; clang: string; sysroot: string } | null {
  const base = wasiSdkDir();
  if (!existsSync(base)) return null;
  for (const root of [base, ...readdirSync(base).map((d) => join(base, d))]) {
    const clang = join(root, "bin", process.platform === "win32" ? "clang++.exe" : "clang++");
    const sysroot = join(root, "share", "wasi-sysroot");
    if (existsSync(clang) && existsSync(sysroot)) return { root, clang, sysroot };
  }
  return null;
}
export function haveWasiSdkCache(): boolean { return wasiSdkPaths() !== null; }
// Fetch+extract the host's wasi-sdk into ~/.cache/qinit/wasi-sdk/. No-op if already cached. Best-effort
// sha256 (upstream publishes a per-asset .sha256; if absent, rely on https transport integrity).
export async function fetchWasiSdk(onProgress?: (recv: number, total: number) => void): Promise<{ dir: string; cached: boolean }> {
  const dir = wasiSdkDir();
  if (haveWasiSdkCache()) return { dir, cached: true };
  const { url } = wasiSdkAsset();
  let sha256 = "";
  try { const r = await fetch(url + ".sha256"); if (r.ok) sha256 = (await r.text()).trim().split(/\s+/)[0] ?? ""; } catch {}
  const buf = await fetchVerify({ url, sha256 }, onProgress);
  await extractTarGz(buf, dir);
  return { dir, cached: false };
}
