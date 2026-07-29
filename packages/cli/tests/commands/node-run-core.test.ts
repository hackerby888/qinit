import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNodeRunCore, type NodeRunCoreDeps } from "../../src/node-run-core";

const temporary: string[] = [];

function coreCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "qinit-node-run-core-"));
  temporary.push(root);
  mkdirSync(join(root, "src", "qpi"), { recursive: true });
  writeFileSync(join(root, "src", "qpi", "qpi.h"), "#pragma once\n");
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node run --core-dir --node-bin bypasses the release manifest", async () => {
  const core = coreCheckout();
  let current: any;
  const unexpected = () => {
    throw new Error("release path must not run");
  };

  const result = await prepareNodeRunCore(
    { "core-dir": core, "node-bin": "/tmp/Qubic" },
    false,
    {
      loadManifest: unexpected as NodeRunCoreDeps["loadManifest"],
      downloadVerifiedAsset:
        unexpected as NodeRunCoreDeps["downloadVerifiedAsset"],
      extractTarGz: unexpected as NodeRunCoreDeps["extractTarGz"],
      cacheHeaders: unexpected as NodeRunCoreDeps["cacheHeaders"],
      readCurrent: unexpected as NodeRunCoreDeps["readCurrent"],
      updateCurrent: (value) => {
        current = value;
        return value;
      },
    },
  );

  expect(result).toEqual({ version: "local", coreHeaders: core, detail: `local ${core}` });
  expect(current).toEqual({ headersVersion: "local", coreHeaders: core });
});

test("node run --core-dir accepts the simulator without --node-bin", async () => {
  const core = coreCheckout();
  const result = await prepareNodeRunCore(
    { "core-dir": core },
    true,
    { updateCurrent: (value) => value },
  );

  expect(result.coreHeaders).toBe(core);
});

test("node run rejects --core-dir with --ref", async () => {
  await expect(
    prepareNodeRunCore(
      { "core-dir": coreCheckout(), ref: "qinit-v1", "node-bin": "/tmp/Qubic" },
      false,
    ),
  ).rejects.toThrow("--core-dir cannot be combined with --ref");
});

test("node run rejects --core-dir without a path", async () => {
  await expect(
    prepareNodeRunCore({ "core-dir": "", "node-bin": "/tmp/Qubic" }, false),
  ).rejects.toThrow("--core-dir requires a path");
});

test("the core backend with --core-dir requires --node-bin", async () => {
  await expect(prepareNodeRunCore({ "core-dir": coreCheckout() }, false)).rejects.toThrow(
    "requires --node-bin <path>",
  );
});

test("node run reports missing and malformed --core-dir paths", async () => {
  const malformed = mkdtempSync(join(tmpdir(), "qinit-node-run-bad-core-"));
  temporary.push(malformed);

  await expect(
    prepareNodeRunCore({ "core-dir": join(malformed, "missing") }, true),
  ).rejects.toThrow("--core-dir not found");
  await expect(prepareNodeRunCore({ "core-dir": malformed }, true)).rejects.toThrow(
    "missing src/qpi/qpi.h",
  );
});

test("manifest-backed node run keeps the cached-header path", async () => {
  let fetches = 0;
  const result = await prepareNodeRunCore(
    {},
    false,
    {
      loadManifest: async () =>
        ({ version: "qinit-v7", headers: { url: "headers.tgz", sha256: "abc" } }) as any,
      readCurrent: () => ({ headersVersion: "qinit-v7", coreHeaders: "/cache/qinit-v7" }),
      existsSync: () => true,
      downloadVerifiedAsset: async () => {
        fetches++;
        return new Uint8Array();
      },
    },
  );

  expect(result).toEqual({
    version: "qinit-v7",
    coreHeaders: "/cache/qinit-v7",
    detail: "cached qinit-v7",
  });
  expect(fetches).toBe(0);
});

test("manifest-backed node run still fetches uncached headers", async () => {
  const calls: string[] = [];
  const progress: Array<[number, number]> = [];
  const result = await prepareNodeRunCore(
    {},
    false,
    {
      loadManifest: async () =>
        ({ version: "qinit-v8", headers: { url: "headers.tgz", sha256: "abc" } }) as any,
      readCurrent: () => null,
      cacheHeaders: () => "/cache/qinit-v8",
      downloadVerifiedAsset: async (_asset, onProgress) => {
        calls.push("fetch");
        onProgress?.(1, 3);
        return new Uint8Array([1, 2, 3]);
      },
      extractTarGz: async (_archive, destination) => {
        calls.push(`extract:${destination}`);
      },
      updateCurrent: (value) => {
        calls.push(`current:${value.headersVersion}`);
        return value;
      },
    },
    (received, total) => progress.push([received, total]),
  );

  expect(result.detail).toBe("fetched qinit-v8");
  expect(calls).toEqual(["fetch", "extract:/cache/qinit-v8", "current:qinit-v8"]);
  expect(progress).toEqual([[1, 3]]);
});

test("offline and simulator manifest-fallback paths reuse cached headers", async () => {
  const current = { headersVersion: "cached-v1", coreHeaders: "/cache/core" };
  const common = { readCurrent: () => current, existsSync: () => true };

  const offline = await prepareNodeRunCore({ offline: "1" }, false, common);
  expect(offline.detail).toBe("reuse cached-v1");

  const simulator = await prepareNodeRunCore({}, true, {
    ...common,
    loadManifest: async () => {
      throw new Error("offline");
    },
  });
  expect(simulator.detail).toBe("cached cached-v1");
});
