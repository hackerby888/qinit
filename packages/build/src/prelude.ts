// The ambient qpi library headers a contract is compiled against but never #includes — their struct/enum/typedef
// definitions (proposal-voting data, oracle interfaces, qpi built-ins) are merged into extractIdl (as its
// `prelude`) so contract field types that reference them resolve instead of staying `unknown`. Cached per core
// path (qpi.h is large); a missing header is skipped, so a partial core tree degrades gracefully.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRELUDE_HEADERS = [
  "src/contracts/qpi.h",
  "src/contract_core/qpi_proposal_voting.h",
  "src/oracle_core/oracle_interfaces_def.h",
];
const preludeCache = new Map<string, string>();

export function qpiPrelude(corePath: string): string {
  let p = preludeCache.get(corePath);
  if (p === undefined) {
    p = PRELUDE_HEADERS.map((h) => {
      try {
        return readFileSync(join(corePath, h), "utf8");
      } catch {
        return "";
      }
    }).join("\n");
    preludeCache.set(corePath, p);
  }
  return p;
}
