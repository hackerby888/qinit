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

export function isContractDoc(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") return false;
  return doc.languageId === "cpp" || /\.(h|hpp)$/.test(doc.fileName);
}
