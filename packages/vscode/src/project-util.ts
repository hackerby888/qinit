import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as vscode from "vscode";
import { blankCommentsAndStrings } from "./lint/qpi-rules";

export const QINIT_JSON = "qinit.json";

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

export function contractStateType(source: string): string | undefined {
  return blankCommentsAndStrings(source).match(
    /\b(?:struct|class)\s+([A-Za-z_]\w*)(?:\s+final)?\s*:\s*(?:(?:public|protected|private)\s+)?ContractBase\b/,
  )?.[1];
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
  const text = blankCommentsAndStrings(source);
  return (
    text.match(/\bINIT_CONTRACT\s*\(\s*([A-Za-z_]\w*)\s*\)/)?.[1] ??
    text.match(/\bContractTesting([A-Za-z_]\w*)\b/)?.[1]
  );
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
