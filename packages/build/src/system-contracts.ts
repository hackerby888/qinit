// Catalog of the built-in (system) contracts, parsed from the fetched core snapshot's contract_def.h.
// index -> { name (on-chain ticker), source file, IDL }. Lets qinit call/ls/state see QX, QEARN, … the
// same way as user-deployed dynamic contracts (every call mechanism is index-driven already).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractIdl, type ContractIdl } from "./idl";
import { qpiPrelude } from "./prelude";

export interface SystemContract { index: number; name: string; file: string; source: string; idl: ContractIdl }

const cache = new Map<string, SystemContract[]>();

// index -> source file, from the `#define <NAME>_CONTRACT_INDEX n` ... `#include "contracts/<File>.h"` blocks.
function indexToFile(defSrc: string): Map<number, string> {
  const out = new Map<number, string>();
  let cur = -1;
  for (const line of defSrc.split("\n")) {
    const d = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
    if (d) { cur = Number(d[1]); continue; }
    const inc = line.match(/#include\s+"contracts\/(\w+\.h)"/);
    if (inc && cur >= 0) out.set(cur, inc[1]);   // last include in the block wins (e.g. Qswap.h over Qswap_old.h)
  }
  return out;
}

// index -> on-chain name, from the contractDescriptions[] = { {"", …}, {"QX", …}, … } array (position = index).
function indexToName(defSrc: string): Map<number, string> {
  const out = new Map<number, string>();
  const m = defSrc.match(/contractDescriptions\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) return out;
  let i = 0;
  for (const e of m[1].matchAll(/\{\s*"([^"]*)"/g)) { if (e[1]) out.set(i, e[1]); i++; }
  return out;
}

// Build the catalog from a resolved core snapshot root (the dir holding src/contract_core + src/contracts).
export function systemContracts(coreRoot: string): SystemContract[] {
  if (cache.has(coreRoot)) return cache.get(coreRoot)!;
  const def = join(coreRoot, "src", "contract_core", "contract_def.h");
  const dir = join(coreRoot, "src", "contracts");
  const out: SystemContract[] = [];
  if (existsSync(def)) {
    const defSrc = readFileSync(def, "utf8");
    const files = indexToFile(defSrc), names = indexToName(defSrc);
    for (const [index, name] of [...names].sort((a, b) => a[0] - b[0])) {
      const file = files.get(index);
      if (!file) continue;
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        const source = readFileSync(path, "utf8").replace(/X_MULTIPLIER/g, "1");   // testnet scaling (sizes only)
        out.push({ index, name, file, source, idl: extractIdl(source, name, { prelude: qpiPrelude(coreRoot) }) });
      } catch { /* skip a contract that fails to parse — never break the catalog */ }
    }
  }
  cache.set(coreRoot, out);
  return out;
}

// Lowercased system names (for the deploy name guard).
export function systemNames(coreRoot: string): Set<string> {
  return new Set(systemContracts(coreRoot).map((c) => c.name.toLowerCase()));
}
