// Per-project config (qinit.json), read by build/deploy/call so commands run
// flag-free inside a `qinit new` project. Precedence: CLI flag > qinit.json > default.
import { existsSync, readFileSync } from "node:fs";

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
