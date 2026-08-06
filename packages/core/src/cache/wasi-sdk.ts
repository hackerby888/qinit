// wasi-sdk (clang + wasi-sysroot for `qinit build`).
// Version 33 exposes getrusage, breaking the toolchain assumptions. The supported pin lives in config.
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchWithTimeout } from "../net/http";
import { downloadVerifiedAsset, extractTarGz } from "./download";
import { cacheRoot } from "./paths";
import toolchains from "../../../../config/toolchains.json";

function wasiSdkAsset(): { url: string; base: string } {
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const os =
    process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  const base = `wasi-sdk-${toolchains.wasiSdk.assetVersion}-${arch}-${os}`;
  return {
    url: `https://github.com/${toolchains.wasiSdk.repository}/releases/download/${toolchains.wasiSdk.releaseTag}/${base}.tar.gz`,
    base,
  };
}
export function wasiSdkDir(): string {
  return join(cacheRoot(), "wasi-sdk");
}
// Resolve clang++ + wasi-sysroot inside the cached sdk (the tarball keeps a nested top dir, so scan one level).
function wasiSdkCachePathsAt(
  base: string,
): { root: string; clang: string; sysroot: string } | null {
  if (!existsSync(base)) return null;
  let roots: string[];
  try {
    const expectedRoot = join(base, wasiSdkAsset().base);
    roots = [
      expectedRoot,
      base,
      ...readdirSync(base)
        .map((entry) => join(base, entry))
        .filter((root) => root !== expectedRoot),
    ];
  } catch {
    return null;
  }
  for (const root of roots) {
    const clang = join(root, "bin", process.platform === "win32" ? "clang++.exe" : "clang++");
    const sysroot = join(root, "share", "wasi-sysroot");
    if (existsSync(clang) && existsSync(sysroot)) return { root, clang, sysroot };
  }
  return null;
}
function wasiSdkCachePaths(): { root: string; clang: string; sysroot: string } | null {
  return wasiSdkCachePathsAt(wasiSdkDir());
}
export interface ManagedWasiSdkStatus {
  currentRoot?: string;
  expectedRoot: string;
  updateAvailable: boolean;
}
export function managedWasiSdkStatus(): ManagedWasiSdkStatus {
  const currentRoot = wasiSdkCachePaths()?.root;
  const expectedRoot = join(wasiSdkDir(), wasiSdkAsset().base);
  return {
    currentRoot,
    expectedRoot,
    updateAvailable: currentRoot !== undefined && currentRoot !== expectedRoot,
  };
}
export function wasiSdkPaths(): { root: string; clang: string; sysroot: string } | null {
  const cached = wasiSdkCachePaths();
  const configuredClang = process.env.WASM_CLANG?.trim();
  const configuredSysroot = process.env.WASI_SYSROOT?.trim();
  const clang = configuredClang || cached?.clang;
  const sysroot = configuredSysroot || cached?.sysroot;
  if (!clang || !sysroot || !existsSync(clang) || !existsSync(sysroot)) return null;
  const root = cached && (!configuredClang || !configuredSysroot)
    ? cached.root
    : dirname(dirname(clang));
  return { root, clang, sysroot };
}
export function haveWasiSdkCache(): boolean {
  return wasiSdkCachePaths() !== null;
}
// Fetch the pinned host SDK. Existing caches stay untouched unless upgrade is requested.
// Upstream sha256 is best-effort; if absent, rely on HTTPS transport integrity.
export async function fetchWasiSdk(
  onProgress?: (recv: number, total: number) => void,
  options?: { upgrade?: boolean },
): Promise<{ dir: string; cached: boolean }> {
  const dir = wasiSdkDir();
  const status = managedWasiSdkStatus();
  if (status.currentRoot && (!options?.upgrade || !status.updateAvailable)) {
    return { dir, cached: true };
  }
  const { url } = wasiSdkAsset();
  let sha256 = "";
  try {
    const r = await fetchWithTimeout(url + ".sha256", undefined, 15000);
    if (r.ok) sha256 = (await r.text()).trim().split(/\s+/)[0] ?? "";
  } catch {}
  const buf = await downloadVerifiedAsset({ url, sha256 }, onProgress);
  const suffix = `${process.pid}.${Date.now()}`;
  const tmp = `${dir}.tmp.${suffix}`;
  const backup = `${dir}.bak.${suffix}`;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  let backedUp = false;
  try {
    await extractTarGz(buf, tmp);
    if (!wasiSdkCachePathsAt(tmp)) {
      throw new Error("downloaded wasi-sdk is missing clang++ or wasi-sysroot");
    }

    if (existsSync(dir)) {
      renameSync(dir, backup);
      backedUp = true;
    }
    try {
      renameSync(tmp, dir);
    } catch (activationError) {
      if (backedUp) {
        try {
          renameSync(backup, dir);
        } catch (rollbackError) {
          const detail = rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
          throw new Error(
            `failed to activate wasi-sdk and restore the previous cache: ${detail}`,
            { cause: activationError },
          );
        }
      }
      throw activationError;
    }
    if (backedUp) rmSync(backup, { recursive: true, force: true });
    return { dir, cached: false };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
