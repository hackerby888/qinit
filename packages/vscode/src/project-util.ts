import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type * as vscode from "vscode";
import { loadConfig } from "@qinit/core/project";
import {
  detectContractName,
  Lexer,
  TokenKind,
} from "@qinit/compiler/analyzer";

export const QINIT_JSON = "qinit.json";

export interface ContractIdentity {
  name?: string;
  slot?: number;
}

export function findProjectRoot(file: string): string | undefined {
  let dir = dirname(file);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, QINIT_JSON))) return dir;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function configuredContractIdentity(file: string): ContractIdentity {
  const project = findProjectRoot(file);
  if (!project) {
    return {};
  }

  const config = loadConfig(join(project, QINIT_JSON));
  if (
    !config.contract ||
    resolve(join(project, config.contract)) !== resolve(file)
  ) {
    return {};
  }

  return {
    name: config.contractName,
    slot: config.slot,
  };
}

export function contractStateType(source: string): string | undefined {
  return detectContractName(source);
}

export function isQpiContractSource(source: string): boolean {
  return contractStateType(source) !== undefined;
}

export function isContractDoc(doc: vscode.TextDocument): boolean {
  return (
    doc.uri.scheme === "file" &&
    /\.(h|hpp|hxx)$/i.test(doc.fileName) &&
    isQpiContractSource(doc.getText())
  );
}

export function projectContractDocuments(
  configFile: string,
  documents: readonly vscode.TextDocument[],
): vscode.TextDocument[] {
  const project = dirname(configFile);
  return documents.filter(
    (document) =>
      findProjectRoot(document.fileName) === project &&
      isContractDoc(document),
  );
}

export function isTestDoc(doc: vscode.TextDocument): boolean {
  return (
    doc.uri.scheme === "file" &&
    /\.(cpp|cc|cxx)$/i.test(doc.fileName) &&
    /#include\s+["<][^">]*contract_testing\.h|(^|\n)\s*TEST\s*\(/.test(doc.getText())
  );
}

export interface ContractCandidate {
  path: string;
  stateType: string;
}

export function testContractType(source: string): string | undefined {
  const tokens = new Lexer(source).tokenize();
  let fallback: string | undefined;

  for (let index = 0; index < tokens.length; index++) {
    if (
      tokens[index].text === "INIT_CONTRACT" &&
      tokens[index + 1]?.kind === TokenKind.L_PAREN &&
      tokens[index + 2]?.kind === TokenKind.IDENTIFIER
    ) {
      return tokens[index + 2].text;
    }
    if (
      tokens[index].kind === TokenKind.IDENTIFIER &&
      tokens[index].text.startsWith("ContractTesting") &&
      tokens[index].text.length > "ContractTesting".length &&
      fallback === undefined
    ) {
      fallback = tokens[index].text.slice("ContractTesting".length);
    }
  }

  return fallback;
}

// How closely a contract sits to the test: how much of the path they share, then how far apart they
// are. Sharing `<project>/` beats sharing only the workspace root, even at equal step counts.
function pathProximity(
  candidatePath: string,
  testPath: string,
): { shared: number; distance: number } {
  const candidateParts = resolve(candidatePath).split(sep);
  const testParts = resolve(testPath).split(sep);
  let shared = 0;
  while (
    shared < candidateParts.length &&
    shared < testParts.length &&
    candidateParts[shared] === testParts[shared]
  ) {
    shared++;
  }
  return {
    shared,
    distance: candidateParts.length - shared + (testParts.length - shared),
  };
}

// One contract name can exist in several directories, so a tie is broken by the file name the test
// carries (`Counter.test.cpp` → `Counter.h`) and then by proximity. Still tied stays ambiguous.
function closestCandidate(
  matches: ContractCandidate[],
  testPath?: string,
): ContractCandidate | undefined {
  if (!testPath) return undefined;

  const testName = basename(testPath).replace(/\.test\.(cpp|cc|cxx)$/i, "");
  const named = matches.filter((candidate) => basename(candidate.path, ".h") === testName);
  const ranked = named.length > 0 ? named : matches;
  if (ranked.length === 1) return ranked[0];

  const scored = ranked.map((candidate) => ({
    candidate,
    ...pathProximity(candidate.path, testPath),
  }));
  const best = scored.reduce((winner, entry) =>
    entry.shared > winner.shared ||
      (entry.shared === winner.shared && entry.distance < winner.distance)
      ? entry
      : winner
  );
  const tied = scored.filter(
    (entry) => entry.shared === best.shared && entry.distance === best.distance,
  );
  return tied.length === 1 ? best.candidate : undefined;
}

export function selectTestContract(
  testSource: string,
  candidates: ContractCandidate[],
  testPath?: string,
): ContractCandidate | undefined {
  const stateType = testContractType(testSource);
  if (stateType) {
    const matches = candidates.filter((candidate) => candidate.stateType === stateType);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return closestCandidate(matches, testPath);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function findContractCandidates(root: string, maxHeaders = 1000): ContractCandidate[] {
  const candidates: ContractCandidate[] = [];
  const pending = [resolve(root)];
  const skipped = new Set([".git", ".qinit", ".vscode", "dist", "node_modules"]);
  let scannedHeaders = 0;

  while (pending.length && scannedHeaders < maxHeaders) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) pending.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.(h|hpp|hxx)$/i.test(entry.name)) continue;
      scannedHeaders++;

      const path = join(dir, entry.name);
      try {
        const stateType = contractStateType(readFileSync(path, "utf8"));
        if (stateType) candidates.push({ path, stateType });
      } catch {}
      if (scannedHeaders >= maxHeaders) break;
    }
  }

  return candidates;
}
