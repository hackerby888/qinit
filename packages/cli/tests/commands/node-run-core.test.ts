import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNodeRunCore, type NodeRunCoreDeps } from "../../src/node-run-core";

const temporary: string[] = [];

function coreCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "qinit-node-run-core-"));
  temporary.push(root);
  mkdirSync(join(root, "src", "contracts"), { recursive: true });
  writeFileSync(join(root, "src", "contracts", "qpi.h"), "#pragma once\n");
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node run --core --bin uses the checkout without loading or downloading a manifest", async () => {
  const core = coreCheckout();
  let current: any;
  const unexpected = () => {
    throw new Error("release path must not run");
  };

  const result = await prepareNodeRunCore(
    { core, bin: "/tmp/Qubic" },
    false,
    {
      loadManifest: unexpected as NodeRunCoreDeps["loadManifest"],
      fetchVerify: unexpected as NodeRunCoreDeps["fetchVerify"],
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

test("node run --core accepts a virtual node without --bin", async () => {
  const core = coreCheckout();
  const result = await prepareNodeRunCore(
    { core },
    true,
    { updateCurrent: (value) => value },
  );

  expect(result.coreHeaders).toBe(core);
});

test("node run rejects --core with --ref", async () => {
  await expect(
    prepareNodeRunCore({ core: coreCheckout(), ref: "qinit-v1", bin: "/tmp/Qubic" }, false),
  ).rejects.toThrow("--core cannot be combined with --ref");
});

test("node run rejects --core without a path", async () => {
  await expect(prepareNodeRunCore({ core: "", bin: "/tmp/Qubic" }, false)).rejects.toThrow(
    "--core requires a path",
  );
});

test("a real node with --core requires --bin", async () => {
  await expect(prepareNodeRunCore({ core: coreCheckout() }, false)).rejects.toThrow(
    "requires --bin <path>",
  );
});

test("node run reports missing and malformed --core paths", async () => {
  const malformed = mkdtempSync(join(tmpdir(), "qinit-node-run-bad-core-"));
  temporary.push(malformed);

  await expect(
    prepareNodeRunCore({ core: join(malformed, "missing") }, true),
  ).rejects.toThrow("--core not found");
  await expect(prepareNodeRunCore({ core: malformed }, true)).rejects.toThrow(
    "missing src/contracts/qpi.h",
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
      fetchVerify: async () => {
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
  const result = await prepareNodeRunCore(
    {},
    false,
    {
      loadManifest: async () =>
        ({ version: "qinit-v8", headers: { url: "headers.tgz", sha256: "abc" } }) as any,
      readCurrent: () => null,
      cacheHeaders: () => "/cache/qinit-v8",
      fetchVerify: async () => {
        calls.push("fetch");
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
  );

  expect(result.detail).toBe("fetched qinit-v8");
  expect(calls).toEqual(["fetch", "extract:/cache/qinit-v8", "current:qinit-v8"]);
});

test("offline and virtual manifest-fallback paths still reuse cached headers", async () => {
  const current = { headersVersion: "cached-v1", coreHeaders: "/cache/core" };
  const common = { readCurrent: () => current, existsSync: () => true };

  const offline = await prepareNodeRunCore({ offline: "1" }, false, common);
  expect(offline.detail).toBe("reuse cached-v1");

  const virtual = await prepareNodeRunCore({}, true, {
    ...common,
    loadManifest: async () => {
      throw new Error("offline");
    },
  });
  expect(virtual.detail).toBe("cached cached-v1");
});
