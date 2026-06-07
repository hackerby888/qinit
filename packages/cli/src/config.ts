// Per-project config (qinit.json), read by build/deploy/call so commands run
// flag-free inside a `qinit new` project. Precedence: CLI flag > qinit.json > default.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCurrent } from "@qinit/core";

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

// Where to find core headers for compiling: explicit checkout > env > fetched snapshot cache.
// No checkout and no fetched snapshot => actionable error.
export function resolveCore(cliCore?: string, cfgCore?: string): string {
  const explicit = cliCore || cfgCore || process.env.QINIT_CORE;
  if (explicit) return resolve(explicit);
  const cur = readCurrent();
  if (cur?.coreHeaders && existsSync(cur.coreHeaders)) return cur.coreHeaders;
  throw new Error("no core headers: run `qinit up` (fetch the published snapshot), or set QINIT_CORE=<core-checkout>");
}
