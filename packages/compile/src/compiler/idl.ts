import type { TranslationUnit } from "../ast";
import { Parser } from "../parser";
import type { GeneratedContractMetadata } from "../codegen";
import type { CompileOpts, ContractIdl } from "./types";

export function extractIdl(
  unit: TranslationUnit,
  opts: CompileOpts,
  generated?: GeneratedContractMetadata,
): ContractIdl {
  if (generated) {
    return {
      name: opts.name,
      slot: opts.slot,
      functions: generated.entries
        .filter((entry) => entry.kind === 0)
        .map(({ name, inputType, inSize, outSize }) => ({ name, inputType, inSize, outSize })),
      procedures: generated.entries
        .filter((entry) => entry.kind !== 0)
        .map(({ name, inputType, inSize, outSize }) => ({ name, inputType, inSize, outSize })),
      stateSize: generated.stateSize,
      sysprocMask: generated.sysprocMask,
    };
  }

  const raw = new Parser([]).extractIdl(unit);
  const functions: ContractIdl["functions"] = [];
  const procedures: ContractIdl["procedures"] = [];
  for (const [name, info] of Object.entries(raw)) {
    const entry = { name, inputType: info.inputType, inSize: info.inSize, outSize: info.outSize };
    if (info.kind === 0) functions.push(entry);
    else procedures.push(entry);
  }
  return { name: opts.name, slot: opts.slot, functions, procedures, stateSize: 0, sysprocMask: 0 };
}
