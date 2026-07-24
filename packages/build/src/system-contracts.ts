import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadQpiHeader } from "@qinit/compile";
import { extractIdl, type ContractIdl } from "./idl";

export interface SystemContract {
  index: number;
  name: string;
  constructionEpoch: number;
  stateType: string;
  file: string;
  source: string;
  idl: ContractIdl;
}

const cache = new Map<string, SystemContract[]>();

function indexToFile(definitionSource: string): Map<number, string> {
  const files = new Map<number, string>();
  let currentIndex = -1;

  for (const line of definitionSource.split("\n")) {
    const explicitIndex = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
    if (explicitIndex) {
      currentIndex = Number(explicitIndex[1]);
      continue;
    }

    const incrementsIndex =
      /\bconstexpr\b.*\w+_CONTRACT_INDEX\s*=\s*\(\s*CONTRACT_INDEX\s*\+\s*1\s*\)/.test(
        line,
      );
    if (incrementsIndex) {
      currentIndex += 1;
      continue;
    }

    const include = line.match(/#include\s+"contracts\/(\w+\.h)"/);
    if (include && currentIndex >= 0) {
      files.set(currentIndex, include[1]);
    }
  }

  return files;
}

function indexToStateType(definitionSource: string): Map<number, string> {
  const stateTypes = new Map<number, string>();
  let currentIndex = -1;

  for (const line of definitionSource.split("\n")) {
    const explicitIndex = line.match(/#define\s+\w+_CONTRACT_INDEX\s+(\d+)/);
    if (explicitIndex) {
      currentIndex = Number(explicitIndex[1]);
      continue;
    }

    const incrementsIndex =
      /\bconstexpr\b.*\w+_CONTRACT_INDEX\s*=\s*\(\s*CONTRACT_INDEX\s*\+\s*1\s*\)/.test(
        line,
      );
    if (incrementsIndex) {
      currentIndex += 1;
      continue;
    }

    const stateType = line.match(/#define\s+CONTRACT_STATE_TYPE\s+(\w+)/);
    if (stateType && currentIndex >= 0) {
      stateTypes.set(currentIndex, stateType[1]);
    }
  }

  return stateTypes;
}

function descriptionEntries(definitionSource: string): string | undefined {
  return definitionSource.match(
    /contractDescriptions\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/,
  )?.[1];
}

function indexToName(definitionSource: string): Map<number, string> {
  const names = new Map<number, string>();
  const descriptions = descriptionEntries(definitionSource);
  if (!descriptions) {
    return names;
  }

  let index = 0;

  for (const entry of descriptions.matchAll(/\{\s*"([^"]*)"/g)) {
    if (entry[1]) {
      names.set(index, entry[1]);
    }
    index++;
  }

  return names;
}

function indexToConstructionEpoch(
  definitionSource: string,
): Map<number, number> {
  const epochs = new Map<number, number>();
  const descriptions = descriptionEntries(definitionSource);
  if (!descriptions) {
    return epochs;
  }

  let index = 0;

  for (const entry of descriptions.matchAll(
    /\{\s*"[^"]*"\s*,\s*(\d+)/g,
  )) {
    epochs.set(index, Number(entry[1]));
    index++;
  }

  return epochs;
}

export function systemContracts(coreRoot: string): SystemContract[] {
  const cachedContracts = cache.get(coreRoot);
  if (cachedContracts) {
    return cachedContracts;
  }

  const definitionPath = join(
    coreRoot,
    "src",
    "contract_core",
    "contract_def.h",
  );
  const contractsDir = join(coreRoot, "src", "contracts");
  const contracts: SystemContract[] = [];

  if (existsSync(definitionPath)) {
    const qpiHeader = loadQpiHeader(coreRoot);
    const definitionSource = readFileSync(definitionPath, "utf8");
    const files = indexToFile(definitionSource);
    const names = indexToName(definitionSource);
    const epochs = indexToConstructionEpoch(definitionSource);
    const stateTypes = indexToStateType(definitionSource);
    const orderedNames = [...names].sort(
      (left, right) => left[0] - right[0],
    );

    for (const [index, name] of orderedNames) {
      if (/^LDYN/.test(name)) {
        continue;
      }

      const file = files.get(index);
      if (!file) {
        throw new Error(
          `system contract ${name} (${index}) has no source mapping`,
        );
      }

      if (/^TestExample/.test(file)) {
        continue;
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
      const stateType = stateTypes.get(index) ?? name;
      contracts.push({
        index,
        name,
        constructionEpoch: epochs.get(index) ?? 0,
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
