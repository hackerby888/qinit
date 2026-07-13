// Project-level config (qinit.json) + core/toolchain resolution, shared by @qinit/cli and the
// VS Code extension. Bun-free (node:fs/path only) so it is safe to call from the Node-based VS Code
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readCurrent } from "./fetch";

export interface QinitConfig {
  name?: string;
  contract?: string;
  slot?: number;
  core?: string;
  rpc?: string;
  system?: string[]; // built-in system contracts to seed onto the virtual node (`qinit system`)
  callees?: { name: string; contract: string }[]; // inter-contract callees to deploy before the main contract
  // (so its CALL_OTHER_CONTRACT names resolve from the registry)
}

// Per-project config (qinit.json). Precedence at the call site: CLI flag > qinit.json > default.
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
  throw new Error(
    "no core headers: run `qinit node run` (fetch the published snapshot), or set QINIT_CORE=<core-checkout>",
  );
}

// Lean, Bun-free re-exports of the toolchain readers, so a consumer can import everything
// project-related from "@qinit/core/project" without dragging in the crypto/rpc barrel.
export { readCurrent, currentPath, cacheRoot, wasiSdkPaths } from "./fetch";
export type { CurrentPointer } from "./fetch";
