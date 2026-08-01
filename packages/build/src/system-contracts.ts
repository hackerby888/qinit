import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadQpiHeader } from "@qinit/compiler";
import { parseContractDefinitionSource } from "./contract-definitions";
import { extractIdl, type ContractIdl } from "./idl";
import { generateWasmContractTestingHeader } from "./recipe";

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

export function parseContractDefinitions(
  definitionSource: string,
): ParsedContractDefinitions {
  const definitions = parseContractDefinitionSource(definitionSource);
  return {
    files: definitions.files,
    names: definitions.names,
    epochs: definitions.epochs,
    stateTypes: definitions.stateTypes,
  };
}

function descriptionsFromDefinitions(
  definitions: ParsedContractDefinitions,
): SystemContractDescription[] {
  return [...definitions.names]
    .sort((left, right) => left[0] - right[0])
    .flatMap(([index, name]) => {
      const file = definitions.files.get(index);
      if (/^LDYN/.test(name) || (file && /^TestExample/.test(file))) {
        return [];
      }
      return [{
        index,
        name,
        constructionEpoch: definitions.epochs.get(index) ?? 0,
      }];
    });
}

function definitionPath(coreRoot: string): string {
  return join(coreRoot, "src", "contract_core", "contract_def.h");
}

export function systemContractDescriptions(
  coreRoot: string,
): SystemContractDescription[] {
  const path = definitionPath(coreRoot);
  if (!existsSync(path)) {
    return [];
  }
  return descriptionsFromDefinitions(
    parseContractDefinitions(readFileSync(path, "utf8")),
  );
}

export function generateWasmContractTestingHeaderForCore(o: {
  corePath: string;
  name: string;
  slot: number;
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
    assetName: o.name,
    constructionEpoch: mainContract?.constructionEpoch ?? 0,
  });
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
    const definitions = parseContractDefinitions(
      readFileSync(contractDefinitionPath, "utf8"),
    );

    for (const description of descriptionsFromDefinitions(definitions)) {
      const { index, name, constructionEpoch } = description;
      const file = definitions.files.get(index);
      if (!file) {
        throw new Error(
          `system contract ${name} (${index}) has no source mapping`,
        );
      }

      const sourcePath = join(contractsDir, file);
      if (!existsSync(sourcePath)) {
        throw new Error(
          `system contract ${name} source is missing: ${sourcePath}`,
        );
      }

      const source = readFileSync(sourcePath, "utf8").replace(
        /X_MULTIPLIER/g,
        "1",
      );
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
  return new Set(
    systemContracts(coreRoot).map((contract) => contract.name.toLowerCase()),
  );
}
