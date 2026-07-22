// Verify platform-sensitive cache paths and release-asset names across CI targets.
import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheRoot,
  cacheDir,
  cacheHeaders,
  currentPath,
  toolsDir,
  cachedVerifyToolPath,
  wasiSdkDir,
  wasiSdkPaths,
  haveWasiSdkCache,
  verifyPlatformKey,
  cliAssetName,
  cliReleaseUrls,
} from "../../src/fetch";

const prev = {
  QINIT_CACHE: process.env.QINIT_CACHE,
  WASM_CLANG: process.env.WASM_CLANG,
  WASI_SYSROOT: process.env.WASI_SYSROOT,
};
const dirs: string[] = [];
afterEach(() => {
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function isolate() {
  const x = mkdtempSync(join(tmpdir(), "qinit-paths-"));
  dirs.push(x);
  process.env.QINIT_CACHE = x;
  delete process.env.WASM_CLANG;
  delete process.env.WASI_SYSROOT;
  return x;
}
function fakeSdk(root: string) {
  const clang = join(root, "bin", process.platform === "win32" ? "clang++.exe" : "clang++");
  const sysroot = join(root, "share", "wasi-sysroot");
  mkdirSync(sysroot, { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(clang, "");
  return { root, clang, sysroot };
}

test("cache paths compose under QINIT_CACHE", () => {
  const x = isolate();
  expect(cacheRoot()).toBe(x);
  expect(cacheDir("v9")).toBe(join(x, "v9"));
  expect(cacheHeaders("v9")).toBe(join(x, "v9", "core-headers"));
  expect(currentPath()).toBe(join(x, "current.json"));
  expect(toolsDir()).toBe(join(x, "tools"));
  expect(wasiSdkDir()).toBe(join(x, "wasi-sdk"));
});

test("cachedVerifyToolPath: .exe on windows, bare elsewhere; under tools/", () => {
  const x = isolate();
  const want = join(
    x,
    "tools",
    process.platform === "win32" ? "contractverify.exe" : "contractverify",
  );
  expect(cachedVerifyToolPath()).toBe(want);
});

test("wasiSdkPaths() -> null when the sdk dir is absent", () => {
  isolate(); // fresh empty cache
  expect(wasiSdkPaths()).toBeNull();
});

test("wasiSdkPaths resolves explicit clang and sysroot overrides", () => {
  const x = isolate();
  const explicit = fakeSdk(join(x, "explicit"));
  process.env.WASM_CLANG = explicit.clang;
  process.env.WASI_SYSROOT = explicit.sysroot;
  expect(wasiSdkPaths()).toEqual(explicit);
});

test("wasiSdkPaths fills missing override components from cache", () => {
  const x = isolate();
  const cached = fakeSdk(join(wasiSdkDir(), "wasi-sdk-29"));
  const explicitClang = fakeSdk(join(x, "explicit-clang")).clang;
  process.env.WASM_CLANG = explicitClang;
  expect(wasiSdkPaths()).toEqual({ ...cached, clang: explicitClang });

  delete process.env.WASM_CLANG;
  const explicitSysroot = fakeSdk(join(x, "explicit-sysroot")).sysroot;
  process.env.WASI_SYSROOT = explicitSysroot;
  expect(wasiSdkPaths()).toEqual({ ...cached, sysroot: explicitSysroot });
});

test("explicit toolchain overrides do not masquerade as a fetched SDK cache", () => {
  const x = isolate();
  const explicit = fakeSdk(join(x, "explicit"));
  process.env.WASM_CLANG = explicit.clang;
  process.env.WASI_SYSROOT = explicit.sysroot;
  expect(wasiSdkPaths()).not.toBeNull();
  expect(haveWasiSdkCache()).toBe(false);
});

test("verifyPlatformKey is <os>-<arch> for this host", () => {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  expect(verifyPlatformKey()).toBe(`${os}-${arch}`);
});

test("cliAssetName / cliReleaseUrls: per-host asset shape", () => {
  const base = "https://github.com/hackerby888/qinit/releases/download/qinit-cli-v1.2.3";
  if (process.platform === "win32") {
    // windows ships only x64 (.exe); `qinit update` self-fetches it (install.ps1 does the first install).
    expect(cliAssetName()).toBe("qinit-windows-x64.exe");
    const u = cliReleaseUrls("qinit-cli-v1.2.3");
    expect(u.name).toBe("qinit-windows-x64.exe");
    expect(u.asset).toBe(`${base}/qinit-windows-x64.exe`);
    expect(u.sums).toBe(`${base}/SHA256SUMS`);
    return;
  }
  const o = process.platform === "darwin" ? "darwin" : "linux";
  const a = process.arch === "arm64" ? "arm64" : "x64";
  expect(cliAssetName()).toBe(`qinit-${o}-${a}`);
  const u = cliReleaseUrls("qinit-cli-v1.2.3");
  expect(u.name).toBe(`qinit-${o}-${a}`);
  expect(u.asset).toBe(`${base}/qinit-${o}-${a}`);
  expect(u.sums).toBe(`${base}/SHA256SUMS`);
});
