// Ensure node lifecycle operations target only the tracked detached process.
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { releasePlatformKey } from "@qinit/core";
import {
  activeNodeScratchDir,
  ensureNodeBinary,
  fetchNodeBinary,
  killNode,
  nodeAlive,
  nodeAssetForPlatform,
} from "../../src/ops/node";

const scratch = () => mkdtempSync(join(tmpdir(), "qinit-nodeops-"));
const pidFile = (s: string) => join(s, "node.pid");
// A detached, long-lived process (own group -> not a child of the test runner, so no zombie on death).
const sleeper = (): number => {
  const c = spawn("bun", ["-e", "setTimeout(() => {}, 30000)"], {
    detached: true,
    stdio: "ignore",
  });
  c.unref();
  return c.pid!;
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("killNode stops ONLY the tracked PID, not an unrelated process", async () => {
  const dir = scratch();
  const mine = sleeper(); // the node qinit manages
  const other = sleeper(); // an unrelated instance that must survive
  try {
    writeFileSync(pidFile(dir), String(mine));
    await killNode(dir);
    expect(alive(mine)).toBe(false); // tracked one killed
    expect(alive(other)).toBe(true); // bystander untouched (no broad kill)
    expect(existsSync(pidFile(dir))).toBe(false); // pidfile cleared on success
  } finally {
    try {
      process.kill(other, "SIGKILL");
    } catch {}
    try {
      process.kill(mine, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killNode is a no-op (no throw, no broad kill) when there is no pidfile", async () => {
  const dir = scratch();
  const bystander = sleeper();
  try {
    await killNode(dir); // nothing tracked -> must not touch anything
    expect(alive(bystander)).toBe(true);
  } finally {
    try {
      process.kill(bystander, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nodeAlive reflects the tracked PID's liveness", async () => {
  const dir = scratch();
  const mine = sleeper();
  try {
    writeFileSync(pidFile(dir), String(mine));
    expect(nodeAlive(dir)).toBe(true);
    process.kill(mine, "SIGKILL");
    for (let i = 0; i < 20 && alive(mine); i++) await sleep(100);
    expect(nodeAlive(dir)).toBe(false);
  } finally {
    try {
      process.kill(mine, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default lifecycle operations follow the persisted active scratch directory", async () => {
  const cache = scratch();
  const customScratch = join(cache, "custom-run");
  const mine = sleeper();
  const originalCache = process.env.QINIT_CACHE;

  try {
    process.env.QINIT_CACHE = cache;
    mkdirSync(customScratch);
    writeFileSync(pidFile(customScratch), String(mine));
    writeFileSync(join(cache, "active-node-scratch"), customScratch);

    expect(activeNodeScratchDir()).toBe(customScratch);
    expect(nodeAlive()).toBe(true);
    await killNode();
    expect(alive(mine)).toBe(false);
    expect(existsSync(join(cache, "active-node-scratch"))).toBe(false);
  } finally {
    if (originalCache === undefined) {
      delete process.env.QINIT_CACHE;
    } else {
      process.env.QINIT_CACHE = originalCache;
    }
    try {
      process.kill(mine, "SIGKILL");
    } catch {}
    rmSync(cache, { recursive: true, force: true });
  }
});

test("node assets follow manifest platform keys and keep the legacy Linux fallback", () => {
  const legacy = { url: "legacy", sha256: "legacy-sha" };
  const windows = { url: "windows", sha256: "windows-sha" };
  const manifest = {
    version: "v1",
    node: legacy,
    nodes: { "windows-x64": windows },
  };

  expect(nodeAssetForPlatform(manifest, "windows-x64")).toBe(windows);
  expect(nodeAssetForPlatform(manifest, "linux-x64")).toBe(legacy);
  expect(nodeAssetForPlatform(manifest, "darwin-x64")).toBeUndefined();
  expect(nodeAssetForPlatform(manifest, "future-riscv64")).toBeUndefined();
});

test("fetchNodeBinary downloads a verified raw platform executable and updates current", async () => {
  const cache = scratch();
  const originalCache = process.env.QINIT_CACHE;
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array([0x51, 0x55, 0x42, 0x49, 0x43]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const platform = releasePlatformKey();
  const filename = process.platform === "win32" ? "Qubic.exe" : "Qubic";

  try {
    process.env.QINIT_CACHE = cache;
    globalThis.fetch = (async () =>
      new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
      })) as unknown as typeof fetch;

    const manifest = {
      version: "qinit-v-direct-node",
      nodes: {
        [platform]: {
          url: "https://example.invalid/Qubic-node",
          sha256,
        },
      },
    };
    const downloaded = await fetchNodeBinary("unused", undefined, manifest);

    expect(basename(downloaded.nodeBinaryPath)).toBe(filename);
    expect(readFileSync(downloaded.nodeBinaryPath)).toEqual(Buffer.from(bytes));
    expect(downloaded.version).toBe(manifest.version);

    const current = JSON.parse(
      readFileSync(join(cache, "current.json"), "utf8"),
    );
    expect(current.nodeVersion).toBe(manifest.version);
    expect(current.node).toBe(downloaded.nodeBinaryPath);

    const staged = await fetchNodeBinary(
      "unused",
      undefined,
      { ...manifest, version: "qinit-v-staged-node" },
      { updateCurrent: false },
    );
    expect(existsSync(staged.nodeBinaryPath)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(cache, "current.json"), "utf8")).nodeVersion,
    ).toBe(manifest.version);

    const badManifest = {
      ...manifest,
      version: "qinit-v-bad-node",
      nodes: {
        [platform]: {
          ...manifest.nodes[platform],
          sha256: "0".repeat(64),
        },
      },
    };
    await expect(
      fetchNodeBinary("unused", undefined, badManifest),
    ).rejects.toThrow("sha256 mismatch");
    expect(
      existsSync(join(cache, badManifest.version, "node", filename)),
    ).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCache === undefined) {
      delete process.env.QINIT_CACHE;
    } else {
      process.env.QINIT_CACHE = originalCache;
    }
    rmSync(cache, { recursive: true, force: true });
  }
});

test("ensureNodeBinary reuses a valid selected node without a network lookup", async () => {
  const cache = scratch();
  const originalCache = process.env.QINIT_CACHE;
  const originalFetch = globalThis.fetch;
  const filename = process.platform === "win32" ? "Qubic.exe" : "Qubic";
  const nodeBinaryPath = join(cache, "qinit-v-cached", "node", filename);
  let requests = 0;

  try {
    process.env.QINIT_CACHE = cache;
    mkdirSync(join(cache, "qinit-v-cached", "node"), { recursive: true });
    writeFileSync(nodeBinaryPath, "node");
    writeFileSync(
      join(cache, "current.json"),
      JSON.stringify({ nodeVersion: "qinit-v-cached", node: nodeBinaryPath }),
    );
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("network must not run");
    }) as unknown as typeof fetch;

    expect(await ensureNodeBinary()).toEqual({
      nodeBinaryPath,
      version: "qinit-v-cached",
      cached: true,
    });
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCache === undefined) delete process.env.QINIT_CACHE;
    else process.env.QINIT_CACHE = originalCache;
    rmSync(cache, { recursive: true, force: true });
  }
});

test("ensureNodeBinary restores a missing node from the installed headers release", async () => {
  const cache = scratch();
  const originalCache = process.env.QINIT_CACHE;
  const originalFetch = globalThis.fetch;
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const platform = releasePlatformKey();
  const coreHeaders = join(cache, "qinit-v-headers", "core-headers");
  const requests: string[] = [];

  try {
    process.env.QINIT_CACHE = cache;
    mkdirSync(coreHeaders, { recursive: true });
    writeFileSync(
      join(cache, "current.json"),
      JSON.stringify({ headersVersion: "qinit-v-headers", coreHeaders }),
    );
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("qinit-manifest.json")) {
        return Response.json({
          version: "qinit-v-headers",
          nodes: { [platform]: { url: "https://example.invalid/node", sha256 } },
        });
      }
      return new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
      });
    }) as unknown as typeof fetch;

    const node = await ensureNodeBinary();
    expect(node.version).toBe("qinit-v-headers");
    expect(node.cached).toBe(false);
    expect(requests[0]).toContain("/download/qinit-v-headers/qinit-manifest.json");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCache === undefined) delete process.env.QINIT_CACHE;
    else process.env.QINIT_CACHE = originalCache;
    rmSync(cache, { recursive: true, force: true });
  }
});

test("ensureNodeBinary does not pair a downloaded node with local headers", async () => {
  const cache = scratch();
  const originalCache = process.env.QINIT_CACHE;
  const originalFetch = globalThis.fetch;
  const coreHeaders = join(cache, "local-core");
  let requests = 0;

  try {
    process.env.QINIT_CACHE = cache;
    mkdirSync(coreHeaders, { recursive: true });
    writeFileSync(
      join(cache, "current.json"),
      JSON.stringify({ headersVersion: "local", coreHeaders }),
    );
    globalThis.fetch = (async () => {
      requests++;
      throw new Error("network must not run");
    }) as unknown as typeof fetch;

    await expect(ensureNodeBinary()).rejects.toThrow(
      "local headers have no matching managed node",
    );

    writeFileSync(
      join(cache, "current.json"),
      JSON.stringify({ headersVersion: "cached", coreHeaders }),
    );
    await expect(ensureNodeBinary()).rejects.toThrow(
      "installed headers do not identify a release",
    );
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCache === undefined) delete process.env.QINIT_CACHE;
    else process.env.QINIT_CACHE = originalCache;
    rmSync(cache, { recursive: true, force: true });
  }
});

test("an explicit latest node request never falls back to the selected cache", async () => {
  const cache = scratch();
  const originalCache = process.env.QINIT_CACHE;
  const originalFetch = globalThis.fetch;
  const nodeBinaryPath = join(cache, "old", "node", "Qubic");
  const requests: string[] = [];

  try {
    process.env.QINIT_CACHE = cache;
    mkdirSync(join(cache, "old", "node"), { recursive: true });
    writeFileSync(nodeBinaryPath, "old");
    writeFileSync(
      join(cache, "current.json"),
      JSON.stringify({ nodeVersion: "old", node: nodeBinaryPath }),
    );
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requests.push(String(input));
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    await expect(ensureNodeBinary("latest")).rejects.toThrow("manifest fetch failed");
    expect(requests[0]).toContain("/releases/latest/download/qinit-manifest.json");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCache === undefined) delete process.env.QINIT_CACHE;
    else process.env.QINIT_CACHE = originalCache;
    rmSync(cache, { recursive: true, force: true });
  }
});
