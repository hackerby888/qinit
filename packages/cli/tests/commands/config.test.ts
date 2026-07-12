// Project config + global seed/theme stores + resolution precedence. A bug here silently signs with the
// wrong seed or builds against the wrong core, so every path is asserted (incl. the validation/throw edges).
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, seedStorePath, savedSeed, setSavedSeed, clearSavedSeed, savedTheme, setSavedTheme, savedMode, setSavedMode, modeStorePath, resolveSeed, resolveCore } from "../../src/config";

const saved = { xdg: process.env.XDG_CONFIG_HOME, cache: process.env.QINIT_CACHE, core: process.env.QINIT_CORE };
const dirs: string[] = [];
function isolate() {
  const x = mkdtempSync(join(tmpdir(), "qinit-cfg-")); dirs.push(x);
  process.env.XDG_CONFIG_HOME = x;
  process.env.QINIT_CACHE = join(x, "cache");
  delete process.env.QINIT_CORE;
  return x;
}
afterEach(() => {
  for (const k of ["XDG_CONFIG_HOME", "QINIT_CACHE", "QINIT_CORE"] as const) {
    const v = saved[k === "XDG_CONFIG_HOME" ? "xdg" : k === "QINIT_CACHE" ? "cache" : "core"];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("loadConfig: missing -> {}, valid -> parsed, malformed -> {}", () => {
  const x = isolate();
  expect(loadConfig(join(x, "nope.json"))).toEqual({});
  const good = join(x, "good.json"); writeFileSync(good, JSON.stringify({ name: "C", slot: 28 }));
  expect(loadConfig(good)).toEqual({ name: "C", slot: 28 });
  const bad = join(x, "bad.json"); writeFileSync(bad, "{not json");
  expect(loadConfig(bad)).toEqual({});
});

test("seed store: round-trip, reject bad seed, ignore corrupt, clear", () => {
  isolate();
  expect(savedSeed()).toBeUndefined();
  const SEED = "b".repeat(55);
  setSavedSeed(SEED);
  expect(savedSeed()).toBe(SEED);
  expect(() => setSavedSeed("too-short")).toThrow(/invalid seed/);
  writeFileSync(seedStorePath(), "GARBAGE");          // corrupt value -> savedSeed rejects it
  expect(savedSeed()).toBeUndefined();
  clearSavedSeed();
  expect(existsSync(seedStorePath())).toBe(false);
});

test("theme store: round-trip", () => {
  isolate();
  expect(savedTheme()).toBeUndefined();
  setSavedTheme("dracula");
  expect(savedTheme()).toBe("dracula");
});

test("mode store: default undefined, round-trip, ignore unknown value", () => {
  isolate();
  expect(savedMode()).toBeUndefined();                // unset -> caller falls back to realnode
  setSavedMode("virtualnode");
  expect(savedMode()).toBe("virtualnode");
  setSavedMode("realnode");
  expect(savedMode()).toBe("realnode");
  writeFileSync(modeStorePath(), "bogus");            // unknown value -> savedMode rejects it
  expect(savedMode()).toBeUndefined();
});

test("resolveSeed precedence: explicit > saved > funded > default", async () => {
  isolate();
  const withFunded = { fundedSeed: async () => "f".repeat(55) };
  const noFunded = { fundedSeed: async () => undefined };
  expect(await resolveSeed(withFunded, "c".repeat(55))).toBe("c".repeat(55));   // explicit wins
  await expect(resolveSeed(withFunded, "bad")).rejects.toThrow(/invalid seed/); // explicit validated
  setSavedSeed("d".repeat(55));
  expect(await resolveSeed(withFunded)).toBe("d".repeat(55));                   // saved over funded
  clearSavedSeed();
  expect(await resolveSeed(withFunded)).toBe("f".repeat(55));                   // funded over default
  expect(await resolveSeed(noFunded)).toBe("a".repeat(55));                     // dev default
});

test("resolveCore: explicit precedence -> absolute; throws when unresolved", () => {
  const x = isolate();
  expect(resolveCore(join(x, "cli-core"))).toBe(join(x, "cli-core"));          // cli wins, absolute
  expect(resolveCore(undefined, join(x, "cfg-core"))).toBe(join(x, "cfg-core"));
  process.env.QINIT_CORE = join(x, "env-core");
  expect(resolveCore()).toBe(join(x, "env-core"));
  delete process.env.QINIT_CORE;
  expect(() => resolveCore()).toThrow(/no core headers/);                      // nothing resolves
});
