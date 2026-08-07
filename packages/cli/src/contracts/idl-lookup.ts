import { LiteRpc, debug } from "@qinit/core";
import { decodeOutput, jsonToInputFormat } from "@qinit/proto";
import {
  AbiTypeKind,
  type ContractEntry,
  type ContractIdl,
} from "@qinit/proto/contract-idl";
import { extractIdl } from "@qinit/build";
import { loadConfiguredQpiHeader } from "../config";
import { contractIdlForSlot, loadContractIdlFile } from "./idl-file";
import { loadContracts, mergeContracts } from "./registry";
import { fmtVal } from "../trace/format";

export type ContractIdls = Map<number, ContractIdl>;

// Every contract slot the node knows, mapped to its IDL, so a caller holding only an inputType can name
// and decode it. Best effort: a slot whose source will not parse is dropped, never the whole map.
export async function loadContractIdls(rpc: LiteRpc): Promise<ContractIdls> {
  const sets = await loadContracts(rpc);
  const catalog = new Map(sets.system.map((contract) => [contract.index, contract]));
  const idls: ContractIdls = new Map();

  let idlFile;
  try {
    idlFile = loadContractIdlFile();
  } catch (error) {
    debug("loadContractIdls: local IDL file unusable", error);
  }

  let qpiHeader: string | undefined;
  try {
    qpiHeader = loadConfiguredQpiHeader();
  } catch (error) {
    debug("loadContractIdls: no core checkout for the qpi header", error);
  }

  for (const contract of mergeContracts(sets).all) {
    const local = idlFile && contractIdlForSlot(idlFile, contract.index, contract.codeHash);
    if (local) {
      idls.set(contract.index, local);
      continue;
    }

    // The catalog already parsed every built-in; reuse that whenever the deployed source is the same one.
    const builtin = catalog.get(contract.index);
    if (builtin && builtin.source === contract.source) {
      idls.set(contract.index, builtin.idl);
      continue;
    }

    if (!contract.source) {
      continue;
    }

    try {
      idls.set(
        contract.index,
        extractIdl(contract.source, contract.name, {
          slot: contract.index,
          qpiHeader,
        }),
      );
    } catch (error) {
      debug(`loadContractIdls: slot ${contract.index} did not parse`, error);
    }
  }

  return idls;
}

// The entry a transaction's inputType names. Procedures only — a transaction cannot invoke a function.
export function entryFor(
  slot: number | null | undefined,
  inputType: number,
  idls: ContractIdls,
): ContractEntry | undefined {
  if (slot == null) {
    return undefined;
  }
  return idls
    .get(slot)
    ?.procedures.find((entry) => entry.inputType === inputType);
}

export interface DecodedInput {
  fields: [name: string, value: string][];
  format?: string;
}

// Decode a call's input against its entry. The buffer is padded or truncated to the registered size the
// way the engine's dispatch frame does it (contract/runtime.ts), so a short input decodes as it executed.
export async function decodeTxInput(
  entry: ContractEntry,
  bytes: Uint8Array,
): Promise<DecodedInput> {
  const type = entry.input;
  if (type.kind !== AbiTypeKind.STRUCT || type.fields.length === 0) {
    return { fields: [] };
  }

  const padded = new Uint8Array(type.size);
  padded.set(bytes.subarray(0, Math.min(bytes.length, type.size)));

  const decoded = await decodeOutput(padded, type);
  const values = type.fields.length === 1 ? [decoded] : decoded;
  const fields = type.fields.map(
    (field, index): [string, string] => [field.name, fmtVal(values[index])],
  );

  // The value grammar is a bonus on top of the named fields — linked_list and overlapping inputs have no
  // representation in it, and that must not cost the caller the fields it could otherwise show.
  try {
    return { fields, format: jsonToInputFormat(type, values) };
  } catch (error) {
    debug("decodeTxInput: no value format for this input", error);
    return { fields };
  }
}
