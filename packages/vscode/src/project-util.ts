// Shared helpers: locate a qinit project root and recognize contract documents.
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type * as vscode from "vscode";

export const QINIT_JSON = "qinit.json";

// Walk up from a file to the nearest qinit.json; that directory is the project root (undefined if none).
export function findProjectRoot(file: string): string | undefined {
  let dir = dirname(file);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, QINIT_JSON))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

// A qpi.h contract — a header. Drives the contract-only machinery (clangd contract TU, Tier-A lint,
// `qinit verify`, IDL hover/quick-fix). A .cpp gtest test is NOT a contract (see isTestDoc).
export function isContractDoc(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  return /\.(h|hpp|hxx)$/.test(doc.fileName);
}

// A core-lite contract_testing.h gtest. It gets its own clangd TU instead of the contract path, so clangd
// resolves TEST/EXPECT_*/ContractTesting and the contract's types.
export function isTestDoc(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  if (/\.(cpp|cc|cxx)$/.test(doc.fileName)) return true;
  return /#include\s+["<][^">]*contract_testing\.h|(^|\n)\s*TEST\s*\(/.test(doc.getText());
}
