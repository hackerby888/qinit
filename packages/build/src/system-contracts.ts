// Catalog of the built-in (system) contracts, parsed from the fetched core snapshot's contract_def.h.
// index -> { name (on-chain ticker), source file, IDL }. Lets qinit call/ls/state see QX, QEARN, … the
// same way as user-deployed dynamic contracts (every call mechanism is index-driven already).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractIdl, type ContractIdl } from "./idl";
import { qpiPrelude } from "./prelude";

export interface SystemContract { index: number; name: string; constructionEpoch: number; stateType: string; file: string; source: string; idl: ContractIdl }

const cache = new Map<string, SystemContract[]>();

// index -> source file, from the `#define <NAME>_CONTRACT_INDEX n` ... `#include "contracts/<File>.h"` blocks.
// The appended test contracts use a relative form `constexpr ... <NAME>_CONTRACT_INDEX = (CONTRACT_INDEX + 1)`
// instead of a literal #define — track that too, else `cur` goes stale and a later #include overwrites the wrong
// index (e.g. TestExampleD.h clobbering GGWP.h at the last numeric index).
function indexToFile(defSrc: string): Map<number, string> {
  const out = new Map<number, string>();
  let cur = -1;
  for (const line of defSrc.split("\n")) {
    const d = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
    if (d) { cur = Number(d[1]); continue; }
    if (/\bconstexpr\b.*\w+_CONTRACT_INDEX\s*=\s*\(\s*CONTRACT_INDEX\s*\+\s*1\s*\)/.test(line)) { cur += 1; continue; }
    const inc = line.match(/#include\s+"contracts\/(\w+\.h)"/);
    if (inc && cur >= 0) out.set(cur, inc[1]);   // last include in the block wins (e.g. Qswap.h over Qswap_old.h)
  }
  return out;
}

// index -> C++ struct type, from the `#define <X>_CONTRACT_INDEX n` ... `#define CONTRACT_STATE_TYPE <Type>`
// blocks. The struct type can differ from the on-chain ticker (e.g. ticker QTRY -> struct QUOTTERY) and is what
// the wrapper must #define so the contract's CONTRACT_STATE_TYPE references resolve.
function indexToStateType(defSrc: string): Map<number, string> {
  const out = new Map<number, string>();
  let cur = -1;
  for (const line of defSrc.split("\n")) {
    const d = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
    if (d) { cur = Number(d[1]); continue; }
    if (/\bconstexpr\b.*\w+_CONTRACT_INDEX\s*=\s*\(\s*CONTRACT_INDEX\s*\+\s*1\s*\)/.test(line)) { cur += 1; continue; }
    const st = line.match(/#define\s+CONTRACT_STATE_TYPE\s+(\w+)/);
    if (st && cur >= 0) out.set(cur, st[1]);
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

function indexToConstructionEpoch(defSrc: string): Map<number, number> {
  const out = new Map<number, number>();
  const m = defSrc.match(/contractDescriptions\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) return out;
  let i = 0;
  for (const entry of m[1].matchAll(/\{\s*"[^"]*"\s*,\s*(\d+)/g)) out.set(i++, Number(entry[1]));
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
    const files = indexToFile(defSrc), names = indexToName(defSrc), epochs = indexToConstructionEpoch(defSrc), stateTypes = indexToStateType(defSrc);
    for (const [index, name] of [...names].sort((a, b) => a[0] - b[0])) {
      const file = files.get(index);
      if (!file) continue;
      if (/^TestExample/.test(file)) continue; // test/example fixtures (TESTEXA-D), not deployable system contracts
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        const source = readFileSync(path, "utf8").replace(/X_MULTIPLIER/g, "1");   // testnet scaling (sizes only)
        out.push({ index, name, constructionEpoch: epochs.get(index) ?? 0, stateType: stateTypes.get(index) ?? name, file, source, idl: extractIdl(source, name, { prelude: qpiPrelude(coreRoot) }) });
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
