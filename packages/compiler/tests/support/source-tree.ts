import {
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) {
    return [path];
  }

  return readdirSync(path)
    .sort()
    .flatMap((entry) => sourceFiles(`${path}/${entry}`))
    .filter((entry) => entry.endsWith(".ts"));
}

export function readSourceTree(relativePath: string, baseUrl: string): string {
  const path = fileURLToPath(new URL(relativePath, baseUrl));
  return sourceFiles(path)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}
