// A trace records what it invoked as a kind plus a number. Both are shown — the number is what the wire
// carries and what a bug report quotes — with the name beside it whenever it can be resolved.
import { SYSTEM_PROCEDURES } from "@qinit/core";
import type { ContractIdl } from "@qinit/proto/contract-idl";

const FUNCTION = 0;
const PROCEDURE = 1;
const SYSPROC = 2;
const MIGRATE = 3;

const SYSPROC_NAMES = new Map<number, string>(
  Object.entries(SYSTEM_PROCEDURES).map(([name, id]) => [id, name]),
);

// `from` is the contract's IDL, or the entry name when the caller already resolved it.
export function entryLabel(
  kind: number,
  entry: number,
  from?: ContractIdl | string,
): string {
  // Migrate records entry 0 and is not a system procedure, so it has to be answered before the id lookup.
  if (kind === MIGRATE) {
    return "migrate";
  }

  if (kind === SYSPROC) {
    const name = SYSPROC_NAMES.get(entry);
    return name ? `sys#${entry} (${name})` : `sys#${entry}`;
  }

  const prefix = kind === FUNCTION ? "fn" : kind === PROCEDURE ? "proc" : `kind${kind}`;
  const idl = typeof from === "string" ? undefined : from;
  const registered =
    kind === FUNCTION ? idl?.functions : kind === PROCEDURE ? idl?.procedures : undefined;
  const name =
    typeof from === "string"
      ? from
      : registered?.find((candidate) => candidate.inputType === entry)?.name;
  return name ? `${prefix}#${entry} (${name})` : `${prefix}#${entry}`;
}
