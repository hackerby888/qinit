import { analyzeContract } from "@qinit/compile/analyzer";

export {
  QINIT_IDL_VERSION,
  AbiContainerKind,
  AbiScalarKind,
  AbiTypeKind,
  formatAbiType,
  parseContractIdl,
} from "@qinit/proto/contract-idl";
export type {
  AbiArray,
  AbiCollection,
  AbiField,
  AbiHashMap,
  AbiHashSet,
  AbiScalar,
  AbiStruct,
  AbiType,
  ContractEntry,
  ContractEnum,
  ContractIdl,
  ContractLog,
  ContractMigration,
} from "@qinit/proto/contract-idl";

import type {
  AbiField,
  ContractEntry,
  ContractEnum,
  ContractIdl,
  ContractLog,
} from "@qinit/proto/contract-idl";

export type Field = AbiField;
export type IdlEntry = ContractEntry;
export type EnumDef = ContractEnum;
export type LogStruct = ContractLog;

export interface ExtractIdlOptions {
  slot?: number;
  qpiHeader?: string;
  stateType?: string;
}

export function extractIdl(
  source: string,
  name: string,
  options: ExtractIdlOptions = {},
): ContractIdl {
  const analysisName = options.stateType ?? name;
  const result = analyzeContract({
    source,
    name: analysisName,
    slot: options.slot,
    qpiHeader: options.qpiHeader,
  });

  if (result.idl) {
    return analysisName === name
      ? result.idl
      : {
          ...result.idl,
          name,
        };
  }

  const details = result.diagnostics
    .map((diagnostic) => `line ${diagnostic.span.line}: ${diagnostic.message}`)
    .join("\n");
  throw new Error(details || `Cannot extract IDL for ${name}`);
}
