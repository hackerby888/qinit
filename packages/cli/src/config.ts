// Per-project config (qinit.json), read by build/deploy/call so commands run
// flag-free inside a `qinit new` project. Precedence: CLI flag > qinit.json > default.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { readCurrent, assertSeed } from "@qinit/core";

export interface QinitConfig {
  name?: string;
  contract?: string;
  slot?: number;
  core?: string;
  rpc?: string;
}

export function loadConfig(path = "qinit.json"): QinitConfig {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as QinitConfig;
  } catch {}
  return {};
}

// Globally-chosen signing seed (a key) — stored in XDG config, NOT the committed qinit.json. `qinit seed` sets it;
// every command that needs a seed uses it (so the user picks once and it auto-fills everywhere).
export function seedStorePath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "qinit", "seed");
}
export function savedSeed(): string | undefined {
  try { const s = readFileSync(seedStorePath(), "utf8").trim(); return /^[a-z]{55}$/.test(s) ? s : undefined; } catch { return undefined; }
}
export function setSavedSeed(seed: string): void {
  assertSeed(seed);
  const p = seedStorePath(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, seed + "\n", { mode: 0o600 });
}
export function clearSavedSeed(): void { try { rmSync(seedStorePath()); } catch {} }

// Seed precedence: explicit (--seed) > saved pick (`qinit seed`) > node funded seed > dev default.
export async function resolveSeed(rpc: { fundedSeed(): Promise<string | undefined> }, explicit?: string): Promise<string> {
  if (explicit) { assertSeed(explicit); return explicit; }
  const saved = savedSeed();
  if (saved) return saved;
  const funded = await rpc.fundedSeed();
  return funded ?? "a".repeat(55);
}

// Where to find core headers for compiling: explicit checkout > env > fetched snapshot cache.
// No checkout and no fetched snapshot => actionable error.
export function resolveCore(cliCore?: string, cfgCore?: string): string {
  const explicit = cliCore || cfgCore || process.env.QINIT_CORE;
  if (explicit) return resolve(explicit);
  const cur = readCurrent();
  if (cur?.coreHeaders && existsSync(cur.coreHeaders)) return cur.coreHeaders;
  throw new Error("no core headers: run `qinit up` (fetch the published snapshot), or set QINIT_CORE=<core-checkout>");
}
