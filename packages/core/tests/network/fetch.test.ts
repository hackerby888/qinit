// OS-sensitive cache/io helpers: atomic write, tar extraction (the Windows `tar -C` bug class),
// body-stream reader, and path builders. These run on every CI OS leg, so they catch portability
// regressions (e.g. MSYS tar path mangling) at the source instead of downstream in core's smoke.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, extractTarGz, readBody, sha256Hex, cacheRoot, cacheDir } from "../../src/index";

const tmp = () => mkdtempSync(join(tmpdir(), "qinit-test-"));

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

test("readBody reads a full response body", async () => {
  const buf = await readBody(new Response(new Uint8Array([9, 8, 7])), 1000);
  expect([...buf]).toEqual([9, 8, 7]);
});

test("sha256Hex matches the empty-input vector", () => {
  expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("cacheRoot honors QINIT_CACHE; cacheDir composes under it", () => {
  const prev = process.env.QINIT_CACHE;
  process.env.QINIT_CACHE = join(tmpdir(), "qinit-cache-x");
  expect(cacheRoot()).toBe(join(tmpdir(), "qinit-cache-x"));
  expect(cacheDir("v1")).toBe(join(tmpdir(), "qinit-cache-x", "v1"));
  if (prev === undefined) delete process.env.QINIT_CACHE;
  else process.env.QINIT_CACHE = prev;
});
