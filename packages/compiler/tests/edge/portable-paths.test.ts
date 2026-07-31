import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const SEARCH_ROOTS = ["packages", "scripts", ".github"];
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"]);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name) || entry.name.startsWith("build-"))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

test("source and test paths are checkout-relative or environment-provided", () => {
  const developerPath =
    /(?:\/home\/[^/]+\/Projects\/|\/Users\/[^/]+\/Projects\/|[A-Za-z]:\\Users\\[^\\]+\\Projects\\)/;
  const offenders = SEARCH_ROOTS.flatMap((directory) => sourceFiles(join(ROOT, directory)))
    .filter((path) => developerPath.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(ROOT.length + 1));
  expect(offenders).toEqual([]);
});

test("package test roots contain domain folders, not flat test files", () => {
  const offenders = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const tests = join(ROOT, "packages", entry.name, "tests");
      try {
        return readdirSync(tests, { withFileTypes: true })
          .filter((child) => child.isFile() && child.name.endsWith(".test.ts"))
          .map((child) => `packages/${entry.name}/tests/${child.name}`);
      } catch {
        return [];
      }
    });
  expect(offenders).toEqual([]);
});
