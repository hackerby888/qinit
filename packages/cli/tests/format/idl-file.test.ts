import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AbiTypeKind,
  QINIT_IDL_VERSION,
  type AbiStruct,
  type ContractIdlArtifact,
  type ContractIdlFile,
} from "@qinit/proto/contract-idl";
import {
  contractIdlForSlot,
  emptyContractIdlFile,
  loadContractIdlFile,
  saveContractIdl,
} from "../../src/idl-file";

const emptyStruct: AbiStruct = {
  kind: AbiTypeKind.STRUCT,
  size: 0,
  align: 1,
  format: "",
  fields: [],
};

const contract: ContractIdlArtifact = {
  version: QINIT_IDL_VERSION,
  name: "Counter",
  slot: 28,
  functions: [],
  procedures: [],
  state: emptyStruct,
  sysprocMask: 0,
  enums: [],
  logs: [],
  dependencies: [],
  codeHash: "abcd",
};

test("IDL v2 file stores contracts by slot", () => {
  const root = mkdtempSync(join(tmpdir(), "qinit-idl-v2-"));
  const path = join(root, "qinit.idl.json");

  saveContractIdl(28, contract, path);

  expect(loadContractIdlFile(path)).toEqual({
    version: QINIT_IDL_VERSION,
    contracts: {
      28: contract,
    },
  });
  expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
});

test("IDL v1 slot maps are rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "qinit-idl-v1-"));
  const path = join(root, "qinit.idl.json");
  writeFileSync(path, JSON.stringify({ 28: { name: "Counter" } }));

  expect(() => loadContractIdlFile(path)).toThrow(/Regenerate it with Qinit/);
});

test("saving validates the new contract", () => {
  const root = mkdtempSync(join(tmpdir(), "qinit-idl-invalid-"));
  const path = join(root, "qinit.idl.json");

  expect(() =>
    saveContractIdl(28, { ...contract, slot: 29 }, path),
  ).toThrow("IDL contract 28 stores slot 29");
});

test("deployed metadata must match the live code hash", () => {
  const file: ContractIdlFile = {
    version: QINIT_IDL_VERSION,
    contracts: { 28: contract },
  };

  expect(contractIdlForSlot(file, 28, "ABCD")).toEqual(contract);
  expect(contractIdlForSlot(file, 28, "different")).toBeUndefined();
});

test("missing IDL file starts as an empty v2 registry", () => {
  expect(emptyContractIdlFile()).toEqual({
    version: QINIT_IDL_VERSION,
    contracts: {},
  });
});
