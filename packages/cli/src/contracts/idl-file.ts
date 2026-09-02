import { QINIT_IDL_VERSION, parseContractIdlFile, type ContractIdlArtifact, type ContractIdlFile } from "@qinit/proto/contract-idl";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_IDL_PATH = "qinit.idl.json";

export function emptyContractIdlFile(): ContractIdlFile {
    return {
        version: QINIT_IDL_VERSION,
        contracts: {},
    };
}

export function loadContractIdlFile(path = DEFAULT_IDL_PATH): ContractIdlFile {
    if (!existsSync(path)) {
        return emptyContractIdlFile();
    }

    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch (error: any) {
        throw new Error(`${path}: ${String(error?.message ?? error)}`);
    }

    // A file from an older Qinit is a stale cache, not an error: drop it so readers fall back to the
    // contract source and the next deploy writes it back at the current version.
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== QINIT_IDL_VERSION) {
        return emptyContractIdlFile();
    }

    try {
        return parseContractIdlFile(value);
    } catch (error: any) {
        throw new Error(`${path}: ${String(error?.message ?? error)}. Regenerate it with Qinit.`);
    }
}

export function contractIdlForSlot(file: ContractIdlFile, slot: number, codeHash?: string): ContractIdlArtifact | undefined {
    const contract = file.contracts[String(slot)];
    if (contract?.codeHash && codeHash && contract.codeHash.toLowerCase() !== codeHash.toLowerCase()) {
        return undefined;
    }
    return contract;
}

export function saveContractIdl(slot: number, contract: ContractIdlArtifact, path = DEFAULT_IDL_PATH): ContractIdlFile {
    const file = loadContractIdlFile(path);
    file.contracts[String(slot)] = contract;
    const parsed = parseContractIdlFile(file);
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
}
