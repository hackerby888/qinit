import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Manifest, VerifyUpdate } from "@qinit/core";
import { runSetup, type SetupDeps, type SetupEvent } from "../../src/commands/setup";

const asset = { url: "https://example.invalid/asset", sha256: "abc" };
const manifest: Manifest = {
  version: "qinit-v1",
  headers: asset,
  nodes: { "linux-x64": asset },
};

function setupDeps(overrides: Partial<SetupDeps> = {}): Partial<SetupDeps> {
  let wasiChecks = 0;
  return {
    loadManifest: async () => manifest,
    prepareNodeRunCore: async (_options, _virtual, _injected, onProgress) => {
      onProgress?.(5, 10);
      return {
        version: manifest.version,
        coreHeaders: "/cache/headers",
        detail: `fetched ${manifest.version}`,
      };
    },
    nodeAssetForPlatform: () => asset,
    fetchNodeBin: async (_ref, onProgress) => {
      onProgress?.(10, 10);
      return { bin: "/cache/Qubic", version: manifest.version };
    },
    wasiSdkPaths: () => {
      wasiChecks++;
      return wasiChecks > 1
        ? {
            root: "/cache/wasi-sdk",
            clang: "/cache/wasi-sdk/bin/clang++",
            sysroot: "/cache/wasi-sdk/share/wasi-sysroot",
          }
        : null;
    },
    fetchWasiSdk: async (onProgress) => {
      onProgress?.(3, 4);
      return { dir: "/cache/wasi-sdk", cached: false };
    },
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
  const deps = setupDeps({
    loadManifest: async () => {
      calls.push("headers");
      return manifest;
    },
    fetchNodeBin: async () => {
      calls.push("node");
      return { bin: "/cache/Qubic", version: manifest.version };
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

  await runSetup((event) => events.push(event), deps);

  expect(calls).toEqual(["headers", "node", "wasi", "verifier"]);
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
      fetchNodeBin: async () => {
        nodeFetches++;
        return { bin: "/cache/Qubic", version: manifest.version };
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

test("setup fails fast when a published dependency cannot be downloaded", async () => {
  let wasiFetches = 0;
  const events: SetupEvent[] = [];

  await expect(
    runSetup(
      (event) => events.push(event),
      setupDeps({
        fetchNodeBin: async () => {
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

test("setup stays download-only", () => {
  const source = readFileSync(
    new URL("../../src/commands/setup.tsx", import.meta.url),
    "utf8",
  );

  expect(source).not.toMatch(
    /\b(?:killNode|launchNode|launchVirtualNode|nodeStatus|waitTicking|nodeAlive)\b/,
  );
});
