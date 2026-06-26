// The ambient qpi library headers a contract is compiled against but never #includes — their struct/enum/typedef
// definitions (proposal-voting data, oracle interfaces, qpi built-ins) are merged into extractIdl (as its
// `prelude`) so contract field types that reference them resolve instead of staying `unknown`. Quoted #includes
// inside these headers are expanded (the oracle registry only #includes its per-interface headers, where the
// OracleQuery/OracleReply structs actually live). Cached per core path; missing headers are skipped, so a partial
// core tree degrades gracefully.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const PRELUDE_HEADERS = [
  "src/contracts/qpi.h",
  "src/contract_core/qpi_proposal_voting.h",
  "src/oracle_core/oracle_interfaces_def.h",
];
const preludeCache = new Map<string, string>();
const MAX_INCLUDE_DEPTH = 4;

export function qpiPrelude(corePath: string): string {
  let cached = preludeCache.get(corePath);
  if (cached !== undefined) {
    return cached;
  }
  const srcRoot = join(corePath, "src");
  const seen = new Set<string>();
  const parts: string[] = [];

  // Load a header, recursively pulling its quoted #includes first (so included defs precede the includer).
  const load = (path: string, depth: number): void => {
    const abs = resolve(path);
    if (seen.has(abs) || depth > MAX_INCLUDE_DEPTH) {
      return;
    }
    seen.add(abs);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return; // missing header — skip, the rest still merges
    }
    for (const m of text.matchAll(/^[ \t]*#include[ \t]+"([^"]+)"/gm)) {
      // resolve relative to the including file's dir (../platform/m256.h) or the src include root (oracle_interfaces/Price.h)
      const found = [join(dirname(abs), m[1]), join(srcRoot, m[1])].find(existsSync);
      if (found) {
        load(found, depth + 1);
      }
    }
    parts.push(text);
  };

  for (const h of PRELUDE_HEADERS) {
    load(join(corePath, h), 0);
  }
  cached = parts.join("\n");
  preludeCache.set(corePath, cached);
  return cached;
}
