import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AbiTypeKind, QINIT_IDL_VERSION, type AbiStruct, type ContractIdlArtifact, type ContractIdlFile } from "@qinit/proto/contract-idl";
import { contractIdlForSlot, emptyContractIdlFile, loadContractIdlFile, saveContractIdl } from "../../src/contracts/idl-file";

const emptyStruct: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    size: 1,
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
    cheats: [],
    dependencies: [],
    codeHash: "abcd",
};

test("the IDL file stores contracts by slot", () => {
    const root = mkdtempSync(join(tmpdir(), "qinit-idl-v4-"));
    const path = join(root, "qinit.idl.json");

    saveContractIdl(28, contract, path);

    expect(loadContractIdlFile(path)).toEqual({
        version: QINIT_IDL_VERSION,
        contracts: {
            28: contract,
        },
    });
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(QINIT_IDL_VERSION);
});

test("a file from an older Qinit is discarded, and the next save rewrites it", () => {
    const root = mkdtempSync(join(tmpdir(), "qinit-idl-stale-"));
    const path = join(root, "qinit.idl.json");
    writeFileSync(
        path,
        JSON.stringify({
            version: QINIT_IDL_VERSION - 1,
            contracts: {
                28: {
                    ...contract,
                    version: QINIT_IDL_VERSION - 1,
                },
            },
        }),
    );

    expect(loadContractIdlFile(path)).toEqual(emptyContractIdlFile());

    saveContractIdl(29, { ...contract, slot: 29 }, path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        version: QINIT_IDL_VERSION,
        contracts: { 29: { ...contract, slot: 29 } },
    });
});

test("a corrupt file at the current version is still rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "qinit-idl-corrupt-"));
    const path = join(root, "qinit.idl.json");
    writeFileSync(
        path,
        JSON.stringify({
            version: QINIT_IDL_VERSION,
            contracts: {
                28: {
                    ...contract,
                    enums: "not an array",
                },
            },
        }),
    );

    expect(() => loadContractIdlFile(path)).toThrow(/Regenerate it with Qinit/);
});

test("saving validates the new contract", () => {
    const root = mkdtempSync(join(tmpdir(), "qinit-idl-invalid-"));
    const path = join(root, "qinit.idl.json");

    expect(() => saveContractIdl(28, { ...contract, slot: 29 }, path)).toThrow("IDL contract 28 stores slot 29");
});

test("deployed metadata must match the live code hash", () => {
    const file: ContractIdlFile = {
        version: QINIT_IDL_VERSION,
        contracts: { 28: contract },
    };

    expect(contractIdlForSlot(file, 28, "ABCD")).toEqual(contract);
    expect(contractIdlForSlot(file, 28, "different")).toBeUndefined();
});

test("missing IDL file starts as an empty registry", () => {
    expect(emptyContractIdlFile()).toEqual({
        version: QINIT_IDL_VERSION,
        contracts: {},
    });
});
