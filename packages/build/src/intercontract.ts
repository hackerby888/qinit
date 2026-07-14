// Inter-contract call auto-derivation. The contract uses the upstream
// CALL_OTHER_CONTRACT_FUNCTION / INVOKE_OTHER_CONTRACT_PROCEDURE macros (portable to mainnet); for the
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CalleeDef { type: string; index: number; include: string } // include = path used in #include

// Parse contract_def.h -> STATE_TYPE -> { index, include "contracts/<H>.h" }.
export function parseContractDef(corePath: string): Map<string, CalleeDef> {
  const src = readFileSync(join(corePath, "src/contract_core/contract_def.h"), "utf8");
  const idx = new Map<string, number>();
  for (const m of src.matchAll(/#define\s+(\w+)_CONTRACT_INDEX\s+(\d+)/g)) idx.set(m[1], Number(m[2]));
  const out = new Map<string, CalleeDef>();
  // Some contracts guard the include behind `#ifdef OLD_X / #include "..._old.h" / #else / #include "...h" /
  // #endif` (QBAY, QSWAP). Allow that optional prefix and capture the live (#else) include, not the _old one.
  const re = /#define\s+CONTRACT_INDEX\s+(\w+)_CONTRACT_INDEX\s*\n\s*#define\s+CONTRACT_STATE_TYPE\s+(\w+)\s*\n\s*#define\s+CONTRACT_STATE2_TYPE\s+\w+\s*\n(?:\s*#ifdef\s+\w+\s*\n\s*#include\s+"[^"]+"\s*\n\s*#else\s*\n)?\s*#include\s+"([^"]+)"/g;
  for (const m of src.matchAll(re)) {
    const i = idx.get(m[1]);
    if (i !== undefined) out.set(m[2], { type: m[2], index: i, include: m[3] });
  }
  return out;
}

// Callee Type names referenced by CALL_OTHER_CONTRACT_FUNCTION / INVOKE_OTHER_CONTRACT_PROCEDURE.
export function scanCallees(src: string): Set<string> {
  const s = new Set<string>();
  for (const m of src.matchAll(/(?:CALL_OTHER_CONTRACT_FUNCTION|INVOKE_OTHER_CONTRACT_PROCEDURE)(?:_E)?\s*\(\s*(\w+)\s*,/g))
    s.add(m[1]);
  return s;
}

// REGISTER_USER_FUNCTION/PROCEDURE(fn, N) -> [{fn, n}].
export function parseRegisters(src: string): { fn: string; n: number }[] {
  const out: { fn: string; n: number }[] = [];
  for (const m of src.matchAll(/REGISTER_USER_(?:FUNCTION|PROCEDURE)\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/g))
    out.push({ fn: m[1], n: Number(m[2]) });
  return out;
}

// Dynamic (Qinit-deployed) callees: Type -> { absolute header path, deployed slot index }.
export type DynCallees = Record<string, { header: string; index: number }>;

// Build the wrapper prelude (empty if the contract makes no inter-contract calls). Resolves the
// transitive closure of callees, compiles their TYPES at their indices (ascending), emits inputType
export function contractIndexDefines(corePath: string): string {
  let src: string;
  try {
    src = readFileSync(join(corePath, "src/contract_core/contract_def.h"), "utf8");
  } catch {
    return "";
  }

  let s = "// ---- all contract indices (contract_def.h) so a directly-#included sibling resolves ----\n";
  for (const m of src.matchAll(/#define\s+(\w+)_CONTRACT_INDEX\s+(\d+)/g)) {
    s += `#ifndef ${m[1]}_CONTRACT_INDEX\n#define ${m[1]}_CONTRACT_INDEX ${m[2]}\n#endif\n`;
  }
  return s;
}

export function buildCalleePrelude(corePath: string, contractSrc: string, dyn: DynCallees = {}, selfType?: string): string {
  const indexBlock = contractIndexDefines(corePath);
  let defMap: Map<string, CalleeDef>;
  try {
    defMap = parseContractDef(corePath);
  } catch {
    defMap = new Map(); // no contract_def.h (e.g. a non-core path) — only CALL-macro callees apply
  }
  const wanted = scanCallees(contractSrc);
  // Also pull siblings referenced by type/static-method/constant (e.g. RL::makeDateStamp, RL_DEFAULT_INIT_TIME,
  // QTF_RANDOM_LOTTERY_ASSET_NAME) — these have no CALL_OTHER_CONTRACT macro for scanCallees to catch, but the
  for (const type of defMap.keys()) {
    if (type !== selfType && new RegExp(`\\b${type}(?:::|_[A-Z])`).test(contractSrc)) {
      wanted.add(type);
    }
  }
  if (wanted.size === 0) return indexBlock;

  interface R { type: string; index: number; include: string; src: string }
  const resolved = new Map<string, R>();
  const resolve = (type: string) => {
    if (resolved.has(type)) return;
    let r: R;
    if (dyn[type]) {
      r = { type, index: dyn[type].index, include: dyn[type].header, src: readFileSync(dyn[type].header, "utf8") };
    } else if (defMap.has(type)) {
      const d = defMap.get(type)!;
      r = { type, index: d.index, include: d.include, src: readFileSync(join(corePath, "src", d.include), "utf8") };
    } else {
      throw new Error(`inter-contract: unknown callee '${type}' (not in contract_def.h, not a declared dynamic callee)`);
    }
    resolved.set(type, r);
    for (const t of scanCallees(r.src)) resolve(t); // transitive callees
  };
  for (const t of wanted) resolve(t);

  const all = [...resolved.values()].sort((a, b) => a.index - b.index);
  let s = "// ---- inter-contract callees (auto-derived from contract_def.h) ----\n";
  for (const c of all) {
    s += `#define CONTRACT_STATE2_TYPE ${c.type}2\n#define CONTRACT_STATE_TYPE ${c.type}\n#define CONTRACT_INDEX ${c.index}\n`;
    s += `#include "${c.include}"\n`;
    s += `#undef CONTRACT_INDEX\n#undef CONTRACT_STATE_TYPE\n#undef CONTRACT_STATE2_TYPE\n`;
  }
  // Callee CONTRACT_INDEX constants. The full build gets these from contract_def.h, but the
  // single-contract TU (qinit lite build + the editor) doesn't include it — so a contract that uses a
  s += "// ---- callee <Type>_CONTRACT_INDEX constants ----\n";
  for (const c of all)
    s += `#ifndef ${c.type}_CONTRACT_INDEX\n#define ${c.type}_CONTRACT_INDEX ${c.index}\n#endif\n`;
  s += "// ---- generated <Type>_<fn>_inputType constants ----\n";
  for (const c of all)
    for (const r of parseRegisters(c.src))
      s += `static constexpr unsigned short ${c.type}_${r.fn}_inputType = ${r.n};\n`;
  s += `#include "extensions/wasm/lite_contract_calls.h"\n`;
  return indexBlock + s;
}
