// Cover platform-sensitive cache, I/O, tar extraction, and response-stream helpers.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWrite,
  extractTarGz,
  readResponseBodyWithTimeout,
  sha256Hex,
  cacheRoot,
  cacheDir,
  loadManifest,
  loadVerifyManifest,
  resolveCliTag,
} from "../../src/index";

const tmp = () => mkdtempSync(join(tmpdir(), "qinit-test-"));
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("atomicWrite writes exact bytes and leaves no .tmp sibling", () => {
  const d = tmp();
  const f = join(d, "blob.bin");
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  atomicWrite(f, data);
  expect(existsSync(f)).toBe(true);
  expect([...readFileSync(f)]).toEqual([...data]);
  expect(readdirSync(d).filter((n) => n.includes(".tmp"))).toEqual([]);
  rmSync(d, { recursive: true, force: true });
});

test("extractTarGz round-trips a gzipped tar into destDir (cwd spawn, no `tar -C`)", async () => {
  const src = tmp();
  writeFileSync(join(src, "a.txt"), "hello");
  // Build the fixture via cwd too (NOT `tar -C <winpath>`) so this test itself is Windows-safe.
  const p = Bun.spawnSync(["tar", "czf", "-", "."], { cwd: src, stdout: "pipe" });
  expect(p.exitCode).toBe(0);
  const dest = join(tmp(), "out");
  await extractTarGz(new Uint8Array(p.stdout), dest);
  expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("hello");
  rmSync(src, { recursive: true, force: true });
});

test("readResponseBodyWithTimeout reads a full response body", async () => {
  const buf = await readResponseBodyWithTimeout(
    new Response(new Uint8Array([9, 8, 7])),
    1000,
  );
  expect([...buf]).toEqual([9, 8, 7]);
});

test("sha256Hex matches the empty-input vector", () => {
  expect(sha256Hex(new Uint8Array())).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("cacheRoot honors QINIT_CACHE; cacheDir composes under it", () => {
  const prev = process.env.QINIT_CACHE;
  process.env.QINIT_CACHE = join(tmpdir(), "qinit-cache-x");
  expect(cacheRoot()).toBe(join(tmpdir(), "qinit-cache-x"));
  expect(cacheDir("v1")).toBe(join(tmpdir(), "qinit-cache-x", "v1"));
  if (prev === undefined) delete process.env.QINIT_CACHE;
  else process.env.QINIT_CACHE = prev;
});

test("release manifests expand asset filenames and preserve HTTPS URLs", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requests.push(String(input));
    return Response.json({
      version: "core-v1.2.3",
      node: { url: "Qubic-linux-x64", sha256: "node" },
      nodes: {
        "linux-arm64": { url: "Qubic-linux-arm64", sha256: "arm" },
        "darwin-arm64": { url: "https://assets.example/Qubic", sha256: "darwin" },
      },
      headers: { url: "core-headers.tar.gz", sha256: "headers" },
    });
  }) as typeof fetch;

  const manifest = await loadManifest("moving-pointer", "new-org/core-lite");
  const base = "https://github.com/new-org/core-lite/releases/download/core-v1.2.3";
  expect(requests).toEqual([
    "https://github.com/new-org/core-lite/releases/download/moving-pointer/qinit-manifest.json",
  ]);
  expect(manifest.node?.url).toBe(`${base}/Qubic-linux-x64`);
  expect(manifest.nodes?.["linux-arm64"]?.url).toBe(`${base}/Qubic-linux-arm64`);
  expect(manifest.nodes?.["darwin-arm64"]?.url).toBe("https://assets.example/Qubic");
  expect(manifest.headers?.url).toBe(`${base}/core-headers.tar.gz`);
});

test("release manifests reject unsafe asset references", async () => {
  for (const url of ["", "../Qubic", "bin/Qubic", "http://example.test/Qubic", "Qubic?raw=1"]) {
    globalThis.fetch = (async () => Response.json({
      version: "core-v1",
      node: { url, sha256: "unused" },
    })) as unknown as typeof fetch;

    await expect(loadManifest("latest", "new-org/core-lite")).rejects.toThrow(
      "core node URL must be an HTTPS URL or asset filename",
    );
  }
});

test("release manifests reject an unsafe version used as an asset tag", async () => {
  globalThis.fetch = (async () => Response.json({
    version: "../core-v1",
    node: { url: "Qubic-linux-x64", sha256: "unused" },
  })) as unknown as typeof fetch;

  await expect(loadManifest("latest", "new-org/core-lite")).rejects.toThrow(
    "core node release tag is invalid: ../core-v1",
  );
});

test("verifier manifests expand filenames against the moving release", async () => {
  globalThis.fetch = (async () => Response.json({
    version: "upstream-v1",
    assets: {
      "linux-x64": { url: "contractverify-linux-x64-deadbeef", sha256: "deadbeef" },
      "darwin-arm64": { url: "https://assets.example/contractverify", sha256: "cafe" },
    },
  })) as unknown as typeof fetch;

  const manifest = await loadVerifyManifest("new-org/qinit");
  expect(manifest.assets["linux-x64"]?.url).toBe(
    "https://github.com/new-org/qinit/releases/download/verify-latest/" +
      "contractverify-linux-x64-deadbeef",
  );
  expect(manifest.assets["darwin-arm64"]?.url).toBe(
    "https://assets.example/contractverify",
  );
});

test("resolveCliTag downloads and trims the stable release pointer", async () => {
  let requestedUrl = "";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    requestedUrl = String(input);
    return new Response("  qinit-cli-v1.2.3\n");
  }) as typeof fetch;

  expect(await resolveCliTag("owner/repo")).toBe("qinit-cli-v1.2.3");
  expect(requestedUrl).toBe(
    "https://github.com/owner/repo/releases/download/qinit-cli-latest/latest.txt",
  );
});

test("resolveCliTag rejects empty and unsafe pointer contents", async () => {
  for (const content of [
    "",
    "   \n",
    "qinit-cli-v1.2.3/asset",
    "qinit-cli-v1.2.3\nqinit-cli-v1.2.4",
    "QINIT-CLI-v1.2.3",
    "other-v1.2.3",
  ]) {
    globalThis.fetch = (async () => new Response(content)) as unknown as typeof fetch;
    expect(await resolveCliTag("owner/repo")).toBeNull();
  }
});

test("resolveCliTag reports pointer HTTP failures", async () => {
  globalThis.fetch = (async () =>
    new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

  await expect(resolveCliTag("owner/repo")).rejects.toThrow(
    "CLI release pointer fetch failed (HTTP 503) from " +
      "https://github.com/owner/repo/releases/download/qinit-cli-latest/latest.txt",
  );
});
