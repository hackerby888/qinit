import {
  LHOST_ABI,
  type LhostFunctionSignature,
  type LhostImportName,
  type LhostValueType,
} from "@qinit/core";

export type LhostAbiSpec = Readonly<Record<string, LhostFunctionSignature>>;

export function lhostSymbol(name: string): string {
  return `$lh_${name}`;
}

export const LHOST_CALL_SIG = Object.freeze(
  Object.fromEntries(
    (Object.entries(LHOST_ABI) as [LhostImportName, (typeof LHOST_ABI)[LhostImportName]][]).map(
      ([name, abi]) => {
        if (abi.results.length > 1)
          throw new Error(`lhost.${name} has an unsupported multi-value result`);
        return [
          lhostSymbol(name),
          {
            params: abi.params,
            res: (abi.results[0] ?? "void") as LhostValueType | "void",
          },
        ];
      },
    ),
  ),
);

export function emitLhostImports(abi: LhostAbiSpec = LHOST_ABI): string {
  return Object.entries(abi)
    .map(([name, abi]) => {
      const params = abi.params.length ? ` (param ${abi.params.join(" ")})` : "";
      const result = abi.results.length ? ` (result ${abi.results[0]})` : "";
      return `  (import "lhost" "${name}" (func ${lhostSymbol(name)}${params}${result}))`;
    })
    .join("\n");
}

const symbols = Object.keys(LHOST_CALL_SIG);
if (new Set(symbols).size !== symbols.length) throw new Error("duplicate lhost compiler symbol");
