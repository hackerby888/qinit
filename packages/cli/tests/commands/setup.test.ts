import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest, VerifyUpdate } from "@qinit/core";
import {
  runSetup,
  type SetupDeps,
  type SetupEvent,
  type SetupUpdate,
} from "../../src/commands/setup-node/setup";

const asset = { url: "https://example.invalid/asset", sha256: "abc" };
const manifest: Manifest = {
  version: "qinit-v1",
  headers: asset,
  nodes: { "linux-x64": asset },
};

function setupDeps(overrides: Partial<SetupDeps> = {}): Partial<SetupDeps> {
  return {
    loadManifest: async () => manifest,
    prepareNodeRunCore: async (_options, _useSimulator, _injected, onProgress) => {
      onProgress?.(5, 10);
      return {
        version: manifest.version,
        coreHeaders: "/cache/headers",
        detail: `fetched ${manifest.version}`,
      };
    },
    nodeAssetForPlatform: () => asset,
    fetchNodeBinary: async (_ref, onProgress) => {
      onProgress?.(10, 10);
      return { nodeBinaryPath: "/cache/Qubic", version: manifest.version };
    },
    ensureNodeBinary: async (_ref, onProgress) => {
      onProgress?.(10, 10);
      return {
        nodeBinaryPath: "/cache/Qubic",
        version: manifest.version,
        cached: true,
      };
    },
    readCurrent: () => null,
    updateCurrent: (patch) => ({ ...patch, syncedAt: "now" }),
    existsSync: () => false,
    wasiSdkPaths: () => {
      return {
        root: "/cache/wasi-sdk",
        clang: "/cache/wasi-sdk/bin/clang++",
        sysroot: "/cache/wasi-sdk/share/wasi-sysroot",
      };
    },
    managedWasiSdkStatus: () => ({
      expectedRoot: "/cache/wasi-sdk/wasi-sdk-29",
      updateAvailable: false,
    }),
    fetchWasiSdk: async (onProgress) => {
      onProgress?.(3, 4);
      return { dir: "/cache/wasi-sdk", cached: false };
    },
    configuredWasiSdk: () => null,
    configuredVerifyTool: () => null,
    autoUpdateVerifyTool: async (options) => {
      options?.onProgress?.(4, 4);
      return { action: "installed", version: "verify-v1" };
    },
    updatesDisabled: () => false,
    ...overrides,
  };
}

test("setup prepares every dependency sequentially and reports download progress", async () => {
  const calls: string[] = [];
  const events: SetupEvent[] = [];
  let prompts = 0;
  const deps = setupDeps({
    loadManifest: async () => {
      calls.push("headers");
      return manifest;
    },
    fetchNodeBinary: async () => {
      calls.push("node");
      return { nodeBinaryPath: "/cache/Qubic", version: manifest.version };
    },
    fetchWasiSdk: async () => {
      calls.push("wasi");
      return { dir: "/cache/wasi-sdk", cached: false };
    },
    autoUpdateVerifyTool: async () => {
      calls.push("verifier");
      return { action: "installed", version: "verify-v1" };
    },
  });

  await runSetup((event) => events.push(event), deps, {
    confirmUpdates: async () => {
      prompts++;
      return false;
    },
  });

  expect(calls).toEqual(["headers", "node", "wasi", "verifier"]);
  expect(prompts).toBe(0);
  expect(
    events.filter((event) => event.state === "ok").map((event) => event.step),
  ).toEqual(["headers", "node", "wasi", "verifier"]);
  expect(events).toContainEqual({
    step: "headers",
    state: "active",
    pct: 0.5,
    detail: undefined,
  });
});

test("setup reuses configured SDK and verifier without downloading them", async () => {
  let wasiFetches = 0;
  let verifierUpdates = 0;

  await runSetup(
    () => {},
    setupDeps({
      configuredWasiSdk: () => "/configured/wasi",
      wasiSdkPaths: () => ({
        root: "/configured/wasi",
        clang: "/configured/wasi/bin/clang++",
        sysroot: "/configured/wasi/share/wasi-sysroot",
      }),
      fetchWasiSdk: async () => {
        wasiFetches++;
        return { dir: "/cache/wasi-sdk", cached: false };
      },
      configuredVerifyTool: () => "/configured/contractverify",
      autoUpdateVerifyTool: async () => {
        verifierUpdates++;
        return { action: "installed" };
      },
    }),
  );

  expect(wasiFetches).toBe(0);
  expect(verifierUpdates).toBe(0);
});

test("setup checks updates for a Qinit-managed verifier cache", async () => {
  let verifierUpdates = 0;

  await runSetup(
    () => {},
    setupDeps({
      configuredVerifyTool: () => null,
      autoUpdateVerifyTool: async () => {
        verifierUpdates++;
        return { action: "current", version: "verify-v1" };
      },
    }),
  );

  expect(verifierUpdates).toBe(1);
});

test("setup skips node and verifier assets that are not published for the host", async () => {
  let nodeFetches = 0;
  const events: SetupEvent[] = [];

  await runSetup(
    (event) => events.push(event),
    setupDeps({
      nodeAssetForPlatform: () => undefined,
      fetchNodeBinary: async () => {
        nodeFetches++;
        return { nodeBinaryPath: "/cache/Qubic", version: manifest.version };
      },
      autoUpdateVerifyTool: async () =>
        ({ action: "unsupported" }) as VerifyUpdate,
    }),
  );

  expect(nodeFetches).toBe(0);
  expect(
    events
      .filter((event) => event.state === "ok")
      .filter((event) => event.detail?.startsWith("skipped"))
      .map((event) => event.step),
  ).toEqual(["node", "verifier"]);
});

test("setup keeps an existing core pair when the latest node is not published", async () => {
  let prompts = 0;
  let nodeFetches = 0;
  let headerRef: string | undefined;

  await runSetup(
    () => {},
    setupDeps({
      readCurrent: () => ({
        headersVersion: "qinit-v0",
        coreHeaders: "/cache/qinit-v0/headers",
        nodeVersion: "qinit-v0",
        node: "/cache/qinit-v0/Qubic",
      }),
      existsSync: () => true,
      nodeAssetForPlatform: () => undefined,
      prepareNodeRunCore: async (options) => {
        headerRef = options.ref;
        return {
          version: "qinit-v0",
          coreHeaders: "/cache/qinit-v0/headers",
          detail: "cached qinit-v0",
        };
      },
      fetchNodeBinary: async () => {
        nodeFetches++;
        return { nodeBinaryPath: "/cache/qinit-v1/Qubic", version: "qinit-v1" };
      },
      ensureNodeBinary: async () => ({
        nodeBinaryPath: "/cache/qinit-v0/Qubic",
        version: "qinit-v0",
        cached: true,
      }),
    }),
    {
      confirmUpdates: async () => {
        prompts++;
        return true;
      },
    },
  );

  expect(prompts).toBe(0);
  expect(headerRef).toBeUndefined();
  expect(nodeFetches).toBe(0);
});

test("setup fails fast when a published dependency cannot be downloaded", async () => {
  let wasiFetches = 0;
  const events: SetupEvent[] = [];

  await expect(
    runSetup(
      (event) => events.push(event),
      setupDeps({
        fetchNodeBinary: async () => {
          throw new Error("checksum mismatch");
        },
        fetchWasiSdk: async () => {
          wasiFetches++;
          return { dir: "/cache/wasi-sdk", cached: false };
        },
      }),
    ),
  ).rejects.toThrow("checksum mismatch");

  expect(wasiFetches).toBe(0);
  expect(events.at(-1)).toMatchObject({
    step: "node",
    state: "fail",
    detail: "checksum mismatch",
  });
});

test("setup reports a failed update check on the headers step", async () => {
  const events: SetupEvent[] = [];

  await expect(
    runSetup(
      (event) => events.push(event),
      setupDeps({
        loadManifest: async () => {
          throw new Error("release unavailable");
        },
      }),
    ),
  ).rejects.toThrow("release unavailable");

  expect(events.at(-1)).toMatchObject({
    step: "headers",
    state: "fail",
    detail: "release unavailable",
  });
});

test("setup treats verifier download failure as fatal unless updates are disabled", async () => {
  await expect(
    runSetup(
      () => {},
      setupDeps({
        autoUpdateVerifyTool: async () => ({ action: "offline" }),
      }),
    ),
  ).rejects.toThrow("contract verifier download failed");

  const events: SetupEvent[] = [];
  await runSetup(
    (event) => events.push(event),
    setupDeps({
      autoUpdateVerifyTool: async () => ({ action: "none" }),
      updatesDisabled: () => true,
    }),
  );
  expect(events.at(-1)).toMatchObject({
    step: "verifier",
    state: "ok",
    detail: "skipped — updates disabled",
  });
});

test("setup rejects a cached SDK hidden by invalid environment overrides", async () => {
  await expect(
    runSetup(
      () => {},
      setupDeps({
        wasiSdkPaths: () => null,
        fetchWasiSdk: async () => ({
          dir: "/cache/wasi-sdk",
          cached: true,
        }),
      }),
    ),
  ).rejects.toThrow("WASM_CLANG and WASI_SYSROOT");
});

test("setup can update the managed half of a partial external WASI override", async () => {
  const cache = mkdtempSync(join(tmpdir(), "qinit-setup-wasi-"));
  const managedRoot = join(cache, "wasi-sdk", "wasi-sdk-previous");
  const managedClang = join(
    managedRoot,
    "bin",
    process.platform === "win32" ? "clang++.exe" : "clang++",
  );
  const externalClang = join(cache, "external", "clang++");
  const previous = {
    cache: process.env.QINIT_CACHE,
    clang: process.env.WASM_CLANG,
    sysroot: process.env.WASI_SYSROOT,
  };
  let sdkOptions: { upgrade?: boolean } | undefined;

  mkdirSync(join(managedRoot, "bin"), { recursive: true });
  mkdirSync(join(managedRoot, "share", "wasi-sysroot"), { recursive: true });
  mkdirSync(join(cache, "external"), { recursive: true });
  writeFileSync(managedClang, "");
  writeFileSync(externalClang, "");
  process.env.QINIT_CACHE = cache;
  process.env.WASM_CLANG = externalClang;
  delete process.env.WASI_SYSROOT;

  try {
    const deps = setupDeps({
      readCurrent: () => ({
        headersVersion: manifest.version,
        coreHeaders: "/cache/headers",
        nodeVersion: manifest.version,
        node: "/cache/Qubic",
      }),
      existsSync: () => true,
      fetchWasiSdk: async (_onProgress, options) => {
        sdkOptions = options;
        return { dir: join(cache, "wasi-sdk"), cached: false };
      },
    });
    delete deps.configuredWasiSdk;
    delete deps.managedWasiSdkStatus;
    delete deps.wasiSdkPaths;

    await runSetup(() => {}, deps, {
      confirmUpdates: async () => true,
    });
    expect(sdkOptions).toEqual({ upgrade: true });
  } finally {
    if (previous.cache === undefined) delete process.env.QINIT_CACHE;
    else process.env.QINIT_CACHE = previous.cache;
    if (previous.clang === undefined) delete process.env.WASM_CLANG;
    else process.env.WASM_CLANG = previous.clang;
    if (previous.sysroot === undefined) delete process.env.WASI_SYSROOT;
    else process.env.WASI_SYSROOT = previous.sysroot;
    rmSync(cache, { recursive: true, force: true });
  }
});

test("setup shows available updates and keeps cached assets when declined", async () => {
  const shown: SetupUpdate[] = [];
  let headerRef: string | undefined;
  let nodeFetches = 0;
  let nodeCacheReads = 0;
  let sdkOptions: { upgrade?: boolean } | undefined;
  let verifierChecks = 0;
  let promptCalls = 0;
  let currentWrites = 0;

  await runSetup(
    () => {},
    setupDeps({
      readCurrent: () => ({
        headersVersion: "qinit-v0",
        coreHeaders: "/cache/qinit-v0/headers",
        nodeVersion: "qinit-v-older",
        node: "/cache/qinit-v0/Qubic",
      }),
      existsSync: () => true,
      prepareNodeRunCore: async (options) => {
        headerRef = options.ref;
        return {
          version: "qinit-v0",
          coreHeaders: "/cache/qinit-v0/headers",
          detail: "cached qinit-v0",
        };
      },
      fetchNodeBinary: async () => {
        nodeFetches++;
        return { nodeBinaryPath: "/cache/qinit-v1/Qubic", version: "qinit-v1" };
      },
      ensureNodeBinary: async () => {
        nodeCacheReads++;
        return {
          nodeBinaryPath: "/cache/qinit-v0/Qubic",
          version: "qinit-v-older",
          cached: true,
        };
      },
      updateCurrent: (patch) => {
        currentWrites++;
        return { ...patch, syncedAt: "now" };
      },
      managedWasiSdkStatus: () => ({
        currentRoot: "/cache/wasi-sdk/wasi-sdk-28",
        expectedRoot: "/cache/wasi-sdk/wasi-sdk-29",
        updateAvailable: true,
      }),
      wasiSdkPaths: () => ({
        root: "/cache/wasi-sdk/wasi-sdk-28",
        clang: "/cache/wasi-sdk/wasi-sdk-28/bin/clang++",
        sysroot: "/cache/wasi-sdk/wasi-sdk-28/share/wasi-sysroot",
      }),
      fetchWasiSdk: async (_onProgress, options) => {
        sdkOptions = options;
        return { dir: "/cache/wasi-sdk", cached: true };
      },
      autoUpdateVerifyTool: async () => {
        verifierChecks++;
        return { action: "current", version: "verify-v1" };
      },
    }),
    {
      onUpdates: (updates) => shown.push(...updates),
      confirmUpdates: async () => {
        promptCalls++;
        return false;
      },
    },
  );

  expect(shown).toEqual([
    {
      key: "core",
      current: "headers qinit-v0 · node qinit-v-older",
      available: "qinit-v1",
      label: "core release",
    },
    {
      key: "wasi",
      current: "wasi-sdk-28",
      available: "wasi-sdk-29",
      label: "WASI SDK",
    },
  ]);
  expect(headerRef).toBeUndefined();
  expect(promptCalls).toBe(1);
  expect(nodeFetches).toBe(0);
  expect(nodeCacheReads).toBe(1);
  expect(currentWrites).toBe(0);
  expect(sdkOptions).toBeUndefined();
  expect(verifierChecks).toBe(1);
});

test("setup --force installs available updates without refreshing current assets", async () => {
  let headerRef: string | undefined;
  let promptCalls = 0;
  let nodeFetches = 0;
  let sdkOptions: { upgrade?: boolean } | undefined;
  const currentWrites: unknown[] = [];

  const oldDeps = setupDeps({
    readCurrent: () => ({
      headersVersion: "qinit-v0",
      coreHeaders: "/cache/qinit-v0/headers",
      nodeVersion: "qinit-v0",
      node: "/cache/qinit-v0/Qubic",
    }),
    existsSync: () => true,
    prepareNodeRunCore: async (options) => {
      headerRef = options.ref;
      return {
        version: manifest.version,
        coreHeaders: "/cache/qinit-v1/headers",
        detail: "fetched qinit-v1",
      };
    },
    fetchNodeBinary: async () => {
      nodeFetches++;
      return { nodeBinaryPath: "/cache/qinit-v1/Qubic", version: manifest.version };
    },
    updateCurrent: (patch) => {
      currentWrites.push(patch);
      return { ...patch, syncedAt: "now" };
    },
    managedWasiSdkStatus: () => ({
      currentRoot: "/cache/wasi-sdk/wasi-sdk-28",
      expectedRoot: "/cache/wasi-sdk/wasi-sdk-29",
      updateAvailable: true,
    }),
    wasiSdkPaths: () => ({
      root: "/cache/wasi-sdk/wasi-sdk-29",
      clang: "/cache/wasi-sdk/wasi-sdk-29/bin/clang++",
      sysroot: "/cache/wasi-sdk/wasi-sdk-29/share/wasi-sysroot",
    }),
    fetchWasiSdk: async (_onProgress, options) => {
      sdkOptions = options;
      return { dir: "/cache/wasi-sdk", cached: false };
    },
  });

  await runSetup(() => {}, oldDeps, {
    force: true,
    confirmUpdates: async () => {
      promptCalls++;
      return false;
    },
  });

  expect(promptCalls).toBe(0);
  expect(headerRef).toBe("latest");
  expect(nodeFetches).toBe(1);
  expect(currentWrites).toEqual([
    {
      headersVersion: "qinit-v1",
      coreHeaders: "/cache/qinit-v1/headers",
      nodeVersion: "qinit-v1",
      node: "/cache/qinit-v1/Qubic",
    },
  ]);
  expect(sdkOptions).toEqual({ upgrade: true });

  nodeFetches = 0;
  sdkOptions = { upgrade: true };
  await runSetup(
    () => {},
    setupDeps({
      readCurrent: () => ({
        headersVersion: manifest.version,
        coreHeaders: "/cache/qinit-v1/headers",
        nodeVersion: manifest.version,
        node: "/cache/qinit-v1/Qubic",
      }),
      existsSync: () => true,
      fetchNodeBinary: async () => {
        nodeFetches++;
        return { nodeBinaryPath: "/cache/qinit-v1/Qubic", version: manifest.version };
      },
      managedWasiSdkStatus: () => ({
        currentRoot: "/cache/wasi-sdk/wasi-sdk-29",
        expectedRoot: "/cache/wasi-sdk/wasi-sdk-29",
        updateAvailable: false,
      }),
      wasiSdkPaths: () => ({
        root: "/cache/wasi-sdk/wasi-sdk-29",
        clang: "/cache/wasi-sdk/wasi-sdk-29/bin/clang++",
        sysroot: "/cache/wasi-sdk/wasi-sdk-29/share/wasi-sysroot",
      }),
      fetchWasiSdk: async (_onProgress, options) => {
        sdkOptions = options;
        return { dir: "/cache/wasi-sdk", cached: true };
      },
    }),
    { force: true },
  );

  expect(nodeFetches).toBe(0);
  expect(sdkOptions).toBeUndefined();
});

test("setup stays download-only", () => {
  const source = readFileSync(
    new URL("../../src/commands/setup-node/setup.tsx", import.meta.url),
    "utf8",
  );

  expect(source).not.toMatch(
    /\b(?:killNode|launchNode|launchSimulatorNode|nodeStatus|waitTicking|nodeAlive)\b/,
  );
});
