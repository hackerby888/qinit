// Cache/tool path + release-asset builders. Pure (env + process.platform/arch driven) — a regression here
// points the node/sdk/verify-tool cache at the wrong place. Runs on every CI OS, so it also pins the
// per-platform shapes (incl. the windows-only `cliAssetName` throw).
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheRoot, cacheDir, cacheHeaders, currentPath, toolsDir, cachedVerifyToolPath, wasiSdkDir, wasiSdkPaths, verifyPlatformKey, cliAssetName, cliReleaseUrls } from "../src/fetch";

const prev = process.env.QINIT_CACHE;
const dirs: string[] = [];
afterEach(() => {
  if (prev === undefined) delete process.env.QINIT_CACHE; else process.env.QINIT_CACHE = prev;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function isolate() { const x = mkdtempSync(join(tmpdir(), "qinit-paths-")); dirs.push(x); process.env.QINIT_CACHE = x; return x; }

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
  const want = join(x, "tools", process.platform === "win32" ? "contractverify.exe" : "contractverify");
  expect(cachedVerifyToolPath()).toBe(want);
});

test("wasiSdkPaths() -> null when the sdk dir is absent", () => {
  isolate();   // fresh empty cache
  expect(wasiSdkPaths()).toBeNull();
});

test("verifyPlatformKey is <os>-<arch> for this host", () => {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  expect(verifyPlatformKey()).toBe(`${os}-${arch}`);
});

test("cliAssetName / cliReleaseUrls: unix shape, or throws on windows", () => {
  if (process.platform === "win32") {
    expect(() => cliAssetName()).toThrow(/unsupported host/);   // windows downloads the .exe manually
    return;
  }
  const o = process.platform === "darwin" ? "darwin" : "linux";
  const a = process.arch === "arm64" ? "arm64" : "x64";
  expect(cliAssetName()).toBe(`qinit-${o}-${a}`);
  const u = cliReleaseUrls("qinit-cli-v1.2.3");
  expect(u.name).toBe(`qinit-${o}-${a}`);
  expect(u.asset).toBe(`https://github.com/hackerby888/qinit/releases/download/qinit-cli-v1.2.3/qinit-${o}-${a}`);
  expect(u.sums).toBe("https://github.com/hackerby888/qinit/releases/download/qinit-cli-v1.2.3/SHA256SUMS");
});
