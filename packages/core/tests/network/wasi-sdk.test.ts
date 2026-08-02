import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import toolchains from "../../../../config/toolchains.json";
import {
  fetchWasiSdk,
  managedWasiSdkStatus,
  wasiSdkDir,
  wasiSdkPaths,
} from "../../src/fetch";

const originalEnv = {
  QINIT_CACHE: process.env.QINIT_CACHE,
  WASM_CLANG: process.env.WASM_CLANG,
  WASI_SYSROOT: process.env.WASI_SYSROOT,
};
const originalFetch = globalThis.fetch;
const temporaryDirs: string[] = [];

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = originalFetch;
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function isolateCache(): string {
  const dir = mkdtempSync(join(tmpdir(), "qinit-wasi-sdk-"));
  temporaryDirs.push(dir);
  process.env.QINIT_CACHE = dir;
  delete process.env.WASM_CLANG;
  delete process.env.WASI_SYSROOT;
  return dir;
}

function fakeSdk(root: string, marker?: string): void {
  const clang = join(root, "bin", process.platform === "win32" ? "clang++.exe" : "clang++");
  mkdirSync(join(root, "share", "wasi-sysroot"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(clang, "");
  if (marker) writeFileSync(join(root, "VERSION"), marker);
}

function makeArchive(expectedRoot: string, valid = true): Uint8Array {
  const source = mkdtempSync(join(tmpdir(), "qinit-wasi-archive-"));
  temporaryDirs.push(source);
  const rootName = basename(expectedRoot);
  const root = join(source, rootName);
  if (valid) fakeSdk(root, "new");
  else mkdirSync(root, { recursive: true });
  const tar = Bun.spawnSync(["tar", "czf", "-", rootName], {
    cwd: source,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(tar.stderr));
  }
  return new Uint8Array(tar.stdout);
}

function serveArchive(archive: Uint8Array, requests?: string[]): () => number {
  let requestCount = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestCount++;
    const url = String(input);
    requests?.push(url);
    if (url.endsWith(".sha256")) {
      return new Response("", { status: 404 });
    }
    return new Response(new Uint8Array(archive));
  }) as unknown as typeof fetch;
  return () => requestCount;
}

test("fetchWasiSdk reuses an older valid cache by default", async () => {
  isolateCache();
  const oldRoot = join(wasiSdkDir(), "wasi-sdk-28");
  fakeSdk(oldRoot, "old");
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount++;
    throw new Error("unexpected fetch");
  }) as unknown as typeof fetch;

  expect(await fetchWasiSdk()).toEqual({ dir: wasiSdkDir(), cached: true });
  expect(requestCount).toBe(0);
  const status = managedWasiSdkStatus();
  expect(status.currentRoot).toBe(oldRoot);
  expect(status.expectedRoot).not.toBe(oldRoot);
  expect(status.updateAvailable).toBe(true);
});

test("fetchWasiSdk upgrade is a no-op for the pinned SDK", async () => {
  isolateCache();
  const expectedRoot = managedWasiSdkStatus().expectedRoot;
  fakeSdk(expectedRoot, "current");
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount++;
    throw new Error("unexpected fetch");
  }) as unknown as typeof fetch;

  expect(await fetchWasiSdk(undefined, { upgrade: true })).toEqual({
    dir: wasiSdkDir(),
    cached: true,
  });
  expect(requestCount).toBe(0);
  expect(managedWasiSdkStatus().updateAvailable).toBe(false);
});

test("fetchWasiSdk upgrade replaces an older SDK", async () => {
  isolateCache();
  const oldRoot = join(wasiSdkDir(), "wasi-sdk-28");
  fakeSdk(oldRoot, "old");
  const expectedRoot = managedWasiSdkStatus().expectedRoot;
  const requestCount = serveArchive(makeArchive(expectedRoot));

  expect(await fetchWasiSdk(undefined, { upgrade: true })).toEqual({
    dir: wasiSdkDir(),
    cached: false,
  });
  expect(requestCount()).toBe(2);
  expect(wasiSdkPaths()?.root).toBe(expectedRoot);
  expect(readFileSync(join(expectedRoot, "VERSION"), "utf8")).toBe("new");
  expect(existsSync(oldRoot)).toBe(false);
  expect(managedWasiSdkStatus().updateAvailable).toBe(false);
});

test("fetchWasiSdk uses the configured release asset", async () => {
  isolateCache();
  const expectedRoot = managedWasiSdkStatus().expectedRoot;
  const requests: string[] = [];
  serveArchive(makeArchive(expectedRoot), requests);

  await fetchWasiSdk();

  const asset = `${basename(expectedRoot)}.tar.gz`;
  const expectedUrl =
    `https://github.com/${toolchains.wasiSdk.repository}/releases/download/` +
    `${toolchains.wasiSdk.releaseTag}/${asset}`;
  expect(requests).toEqual([`${expectedUrl}.sha256`, expectedUrl]);
});

test("fetchWasiSdk preserves the old SDK when replacement validation fails", async () => {
  const cache = isolateCache();
  const oldRoot = join(wasiSdkDir(), "wasi-sdk-28");
  fakeSdk(oldRoot, "old");
  const expectedRoot = managedWasiSdkStatus().expectedRoot;
  serveArchive(makeArchive(expectedRoot, false));

  await expect(fetchWasiSdk(undefined, { upgrade: true })).rejects.toThrow(
    "downloaded wasi-sdk is missing clang++ or wasi-sysroot",
  );
  expect(wasiSdkPaths()?.root).toBe(oldRoot);
  expect(readFileSync(join(oldRoot, "VERSION"), "utf8")).toBe("old");
  expect(readdirSync(cache).filter((name) => name.includes("wasi-sdk.tmp"))).toEqual([]);
});
