import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as vscode from "vscode";
import { loadConfig } from "@qinit/core/project";
import {
  detectContractName,
  Lexer,
  TokenKind,
} from "@qinit/compile/analyzer";

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
    name: config.name,
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

export function selectTestContract(
  testSource: string,
  candidates: ContractCandidate[],
): ContractCandidate | undefined {
  const stateType = testContractType(testSource);
  if (stateType) {
    const matches = candidates.filter((candidate) => candidate.stateType === stateType);
    if (matches.length === 1) return matches[0];
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
