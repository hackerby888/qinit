// Catalog built-in contracts from the fetched core snapshot's contract_def.h.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadQpiHeader } from "@qinit/compile";
import { extractIdl, type ContractIdl } from "./idl";

export interface SystemContract {
  index: number;
  name: string;
  constructionEpoch: number;
  stateType: string;
  file: string;
  source: string;
  idl: ContractIdl;
}

const cache = new Map<string, SystemContract[]>();

// index -> source file, from the `#define <NAME>_CONTRACT_INDEX n` ... `#include "contracts/<File>.h"` blocks.
// The appended test contracts use a relative form `constexpr ... <NAME>_CONTRACT_INDEX = (CONTRACT_INDEX + 1)`
function indexToFile(defSrc: string): Map<number, string> {
  const out = new Map<number, string>();
  let currentIndex = -1;
  for (const line of defSrc.split("\n")) {
    const explicitIndex = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
    if (explicitIndex) {
      currentIndex = Number(explicitIndex[1]);
      continue;
    }
    if (/\bconstexpr\b.*\w+_CONTRACT_INDEX\s*=\s*\(\s*CONTRACT_INDEX\s*\+\s*1\s*\)/.test(line)) {
      currentIndex += 1;
      continue;
    }
    const include = line.match(/#include\s+"contracts\/(\w+\.h)"/);
    // The last include in a block wins, such as Qswap.h over Qswap_old.h.
    if (include && currentIndex >= 0) out.set(currentIndex, include[1]);
  }
  return out;
}

// index -> C++ struct type, from the `#define <X>_CONTRACT_INDEX n` ... `#define CONTRACT_STATE_TYPE <Type>`
// The struct type can differ from the ticker, such as QTRY using QUOTTERY.
function indexToStateType(defSrc: string): Map<number, string> {
  const out = new Map<number, string>();
  let currentIndex = -1;
  for (const line of defSrc.split("\n")) {
    const explicitIndex = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
    if (explicitIndex) {
      currentIndex = Number(explicitIndex[1]);
      continue;
    }
    if (/\bconstexpr\b.*\w+_CONTRACT_INDEX\s*=\s*\(\s*CONTRACT_INDEX\s*\+\s*1\s*\)/.test(line)) {
      currentIndex += 1;
      continue;
    }
    const stateType = line.match(/#define\s+CONTRACT_STATE_TYPE\s+(\w+)/);
    if (stateType && currentIndex >= 0) out.set(currentIndex, stateType[1]);
  }
  return out;
}

// index -> on-chain name, from the contractDescriptions[] = { {"", …}, {"QX", …}, … } array (position = index).
function indexToName(defSrc: string): Map<number, string> {
  const out = new Map<number, string>();
  const m = defSrc.match(/contractDescriptions\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) return out;
  let index = 0;
  for (const entry of m[1].matchAll(/\{\s*"([^"]*)"/g)) {
    if (entry[1]) out.set(index, entry[1]);
    index++;
  }
  return out;
}

function indexToConstructionEpoch(defSrc: string): Map<number, number> {
  const out = new Map<number, number>();
  const m = defSrc.match(/contractDescriptions\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!m) return out;
  let index = 0;
  for (const entry of m[1].matchAll(/\{\s*"[^"]*"\s*,\s*(\d+)/g)) {
    out.set(index++, Number(entry[1]));
  }
  return out;
}

// Build the catalog from a resolved core snapshot root (the dir holding src/contract_core + src/contracts).
export function systemContracts(coreRoot: string): SystemContract[] {
  if (cache.has(coreRoot)) return cache.get(coreRoot)!;
  const def = join(coreRoot, "src", "contract_core", "contract_def.h");
  const dir = join(coreRoot, "src", "contracts");
  const out: SystemContract[] = [];
  if (existsSync(def)) {
    const qpiHeader = loadQpiHeader(coreRoot);
    const defSrc = readFileSync(def, "utf8");
    const files = indexToFile(defSrc);
    const names = indexToName(defSrc);
    const epochs = indexToConstructionEpoch(defSrc);
    const stateTypes = indexToStateType(defSrc);
    for (const [index, name] of [...names].sort((a, b) => a[0] - b[0])) {
      if (/^LDYN/.test(name)) continue;
      const file = files.get(index);
      if (!file) {
        throw new Error(`system contract ${name} (${index}) has no source mapping`);
      }
      if (/^TestExample/.test(file)) continue; // test/example fixtures (TESTEXA-D), not deployable system contracts
      const path = join(dir, file);
      if (!existsSync(path)) {
        throw new Error(`system contract ${name} source is missing: ${path}`);
      }
      // Normalize testnet size scaling before IDL extraction.
      const source = readFileSync(path, "utf8").replace(/X_MULTIPLIER/g, "1");
      const stateType = stateTypes.get(index) ?? name;
      out.push({
        index,
        name,
        constructionEpoch: epochs.get(index) ?? 0,
        stateType,
        file,
        source,
        idl: extractIdl(source, name, {
          slot: index,
          qpiHeader,
          stateType,
        }),
      });
    }
  }
  cache.set(coreRoot, out);
  return out;
}

// Lowercased system names (for the deploy name guard).
export function systemNames(coreRoot: string): Set<string> {
  return new Set(systemContracts(coreRoot).map((c) => c.name.toLowerCase()));
}
