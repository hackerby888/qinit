import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadQpiHeader } from "@qinit/compiler";
import { parseContractDefinitionSource } from "./contract-def";
import { extractIdl, type ContractIdl } from "../compile/idl";
import { scanCallees } from "./intercontract";
import { generateWasmContractTestingHeader } from "../compile/clang";

export interface SystemContract {
    index: number;
    name: string;
    constructionEpoch: number;
    stateType: string;
    file: string;
    source: string;
    idl: ContractIdl;
}

export interface SystemContractDescription {
    index: number;
    name: string;
    constructionEpoch: number;
}

const cache = new Map<string, SystemContract[]>();

export interface ParsedContractDefinitions {
    files: Map<number, string>;
    names: Map<number, string>;
    epochs: Map<number, number>;
    stateTypes: Map<number, string>;
}

export function parseContractDefinitions(definitionSource: string): ParsedContractDefinitions {
    const definitions = parseContractDefinitionSource(definitionSource);
    return {
        files: definitions.files,
        names: definitions.names,
        epochs: definitions.epochs,
        stateTypes: definitions.stateTypes,
    };
}

function descriptionsFromDefinitions(definitions: ParsedContractDefinitions): SystemContractDescription[] {
    return [...definitions.names]
        .sort((left, right) => left[0] - right[0])
        .flatMap(([index, name]) => {
            const file = definitions.files.get(index);
            if (/^LDYN/.test(name) || (file && /^TestExample/.test(file))) {
                return [];
            }
            return [
                {
                    index,
                    name,
                    constructionEpoch: definitions.epochs.get(index) ?? 0,
                },
            ];
        });
}

function definitionPath(coreRoot: string): string {
    return join(coreRoot, "src", "contract_core", "contract_def.h");
}

export function systemContractDescriptions(coreRoot: string): SystemContractDescription[] {
    const path = definitionPath(coreRoot);
    if (!existsSync(path)) {
        return [];
    }
    return descriptionsFromDefinitions(parseContractDefinitions(readFileSync(path, "utf8")));
}

export function generateWasmContractTestingHeaderForCore(o: {
    corePath: string;
    contractName: string;
    slot: number;
    additionalContracts?: readonly { index: number; name: string }[];
}): string {
    const catalog = systemContractDescriptions(o.corePath);
    const mainContract = catalog.find((contract) => contract.index === o.slot);
    const descriptions = catalog
        .filter((contract) => contract.index !== o.slot)
        .map((contract) => ({
            index: contract.index,
            assetName: contract.name,
            constructionEpoch: contract.constructionEpoch,
        }));
    descriptions.push({
        index: o.slot,
        assetName: o.contractName,
        constructionEpoch: mainContract?.constructionEpoch ?? 0,
    });
    for (const contract of o.additionalContracts ?? []) {
        const existing = descriptions.find((description) => description.index === contract.index);
        if (existing) {
            existing.assetName = contract.name;
            continue;
        }
        descriptions.push({
            index: contract.index,
            assetName: contract.name,
            constructionEpoch: 0,
        });
    }
    return generateWasmContractTestingHeader(descriptions);
}

export function systemContracts(coreRoot: string): SystemContract[] {
    const cachedContracts = cache.get(coreRoot);
    if (cachedContracts) {
        return cachedContracts;
    }

    const contractDefinitionPath = definitionPath(coreRoot);
    const contractsDir = join(coreRoot, "src", "contracts");
    const contracts: SystemContract[] = [];

    if (existsSync(contractDefinitionPath)) {
        const qpiHeader = loadQpiHeader(coreRoot);
        const definitions = parseContractDefinitions(readFileSync(contractDefinitionPath, "utf8"));

        for (const description of descriptionsFromDefinitions(definitions)) {
            const { index, name, constructionEpoch } = description;
            const file = definitions.files.get(index);
            if (!file) {
                throw new Error(`system contract ${name} (${index}) has no source mapping`);
            }

            const sourcePath = join(contractsDir, file);
            if (!existsSync(sourcePath)) {
                throw new Error(`system contract ${name} source is missing: ${sourcePath}`);
            }

            const source = readFileSync(sourcePath, "utf8").replace(/X_MULTIPLIER/g, "1");
            const stateType = definitions.stateTypes.get(index) ?? name;
            contracts.push({
                index,
                name,
                constructionEpoch,
                stateType,
                file,
                source,
                idl: extractIdl(source, name, {
                    slot: index,
                    qpiHeader,
                    stateType,
                }),
            });
        }
    }

    cache.set(coreRoot, contracts);
    return contracts;
}

export function systemNames(coreRoot: string): Set<string> {
    return new Set(systemContracts(coreRoot).map((contract) => contract.name.toLowerCase()));
}

export function systemContractClosure(coreRoot: string, name: string): SystemContract[] {
    const catalog = systemContracts(coreRoot);
    const contractsByIdentifier = new Map<string, SystemContract>();
    for (const contract of catalog) {
        contractsByIdentifier.set(contract.name.toLowerCase(), contract);
        contractsByIdentifier.set(contract.stateType.toLowerCase(), contract);
    }

    const target = contractsByIdentifier.get(name.toLowerCase());
    if (!target) {
        throw new Error(`unknown system contract '${name}' — have: ${catalog.map((contract) => contract.name).join(", ")}`);
    }

    const qpiHeader = loadQpiHeader(coreRoot);
    const knownCallees = new Set(catalog.flatMap((contract) => [contract.name, contract.stateType]));
    const visited = new Set<number>();
    const visiting: SystemContract[] = [];
    const ordered: SystemContract[] = [];

    const visit = (contract: SystemContract): void => {
        if (visited.has(contract.index)) {
            return;
        }

        const cycleIndex = visiting.findIndex((candidate) => candidate.index === contract.index);
        if (cycleIndex >= 0) {
            const cycle = [...visiting.slice(cycleIndex), contract].map((candidate) => candidate.name).join(" -> ");
            throw new Error(`system contract dependency cycle: ${cycle}`);
        }

        visiting.push(contract);
        const references = scanCallees(
            contract.source,
            {
                contractName: contract.stateType,
                slot: contract.index,
                qpiHeader,
            },
            knownCallees,
        );
        for (const reference of references) {
            const dependency = contractsByIdentifier.get(reference.toLowerCase());
            if (!dependency) {
                throw new Error(`system contract ${contract.name} references unknown contract '${reference}'`);
            }
            if (dependency.index === contract.index) {
                continue;
            }
            if (dependency.index >= contract.index) {
                throw new Error(
                    `system contract ${contract.name} (${contract.index}) must call a lower canonical slot, got ${dependency.name} (${dependency.index})`,
                );
            }
            visit(dependency);
        }
        visiting.pop();
        visited.add(contract.index);
        ordered.push(contract);
    };

    visit(target);
    return ordered.sort((left, right) => left.index - right.index);
}
