import { describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  dirname,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const MAX_SOURCE_LINES = 500;

const FORBIDDEN_LAYER_IMPORTS: Record<string, Set<string>> = {
  shared: new Set(["ast", "frontend", "analysis", "backend", "compiler", "codegen"]),
  ast: new Set(["frontend", "analysis", "backend", "compiler", "codegen"]),
  frontend: new Set(["analysis", "backend", "compiler", "codegen"]),
  analysis: new Set(["backend", "compiler", "codegen"]),
  backend: new Set(["compiler", "codegen"]),
};

interface ModuleReference {
  specifier: string;
  typeOnly: boolean;
}

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = resolve(directory, entry);

      if (statSync(path).isDirectory()) {
        return collectTypeScriptFiles(path);
      }

      return path.endsWith(".ts") ? [path] : [];
    });
}

function sourcePath(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join("/");
}

function sourceLayer(path: string): string {
  return sourcePath(path).split("/")[0];
}

function isGeneratedSource(source: string): boolean {
  const header = source.split(/\r?\n/, 10).join("\n").toLowerCase();

  return (
    header.includes("@generated") ||
    header.includes("generated file") ||
    header.includes("do not edit")
  );
}

function collectModuleReferences(source: string): ModuleReference[] {
  const references: ModuleReference[] = [];
  const importPattern = /\bimport\s+(type\s+)?(?:(?:[\w$*,\s{}]+)\s+from\s+)?["']([^"']+)["']/g;
  const exportPattern = /\bexport\s+(type\s+)?(?:\*\s*(?:as\s+[\w$]+\s+)?|\{[^}]*\}\s*)from\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(importPattern)) {
    references.push({
      specifier: match[2],
      typeOnly: match[1] !== undefined,
    });
  }

  for (const match of source.matchAll(exportPattern)) {
    references.push({
      specifier: match[2],
      typeOnly: match[1] !== undefined,
    });
  }

  return references;
}

function resolveSourceModule(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const basePath = resolve(dirname(importer), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    resolve(basePath, "index.ts"),
  ];

  return candidates.find((candidate) => {
    return existsSync(candidate) && statSync(candidate).isFile();
  });
}

function buildRuntimeGraph(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const dependencies = collectModuleReferences(source)
      .filter((reference) => !reference.typeOnly)
      .map((reference) => resolveSourceModule(file, reference.specifier))
      .filter((dependency): dependency is string => dependency !== undefined);

    graph.set(file, dependencies);
  }

  return graph;
}

function findRuntimeCycles(graph: Map<string, string[]>): string[][] {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (file: string): void => {
    state.set(file, "visiting");
    stack.push(file);

    for (const dependency of graph.get(file) ?? []) {
      const dependencyState = state.get(dependency);

      if (dependencyState === "visiting") {
        const cycleStart = stack.indexOf(dependency);
        cycles.push([...stack.slice(cycleStart), dependency]);
        continue;
      }

      if (dependencyState !== "visited") {
        visit(dependency);
      }
    }

    stack.pop();
    state.set(file, "visited");
  };

  for (const file of graph.keys()) {
    if (state.get(file) === undefined) {
      visit(file);
    }
  }

  return cycles;
}

describe("compiler module boundaries", () => {
  const sourceFiles = collectTypeScriptFiles(SOURCE_ROOT);

  test("keeps handwritten modules focused", () => {
    const oversizedFiles = sourceFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");

      if (isGeneratedSource(source)) {
        return [];
      }

      const lineCount = source.split(/\r?\n/).length;
      return lineCount > MAX_SOURCE_LINES
        ? [`${sourcePath(file)}: ${lineCount} lines`]
        : [];
    });

    expect(oversizedFiles).toEqual([]);
  });

  test("keeps runtime dependencies acyclic", () => {
    const cycles = findRuntimeCycles(buildRuntimeGraph(sourceFiles)).map((cycle) => {
      return cycle.map(sourcePath);
    });

    expect(cycles).toEqual([]);
  });

  test("keeps dependencies pointed toward lower compiler layers", () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const importerLayer = sourceLayer(file);
      const forbiddenLayers = FORBIDDEN_LAYER_IMPORTS[importerLayer];

      if (forbiddenLayers === undefined) {
        continue;
      }

      const source = readFileSync(file, "utf8");

      for (const reference of collectModuleReferences(source)) {
        const dependency = resolveSourceModule(file, reference.specifier);

        if (dependency === undefined) {
          continue;
        }

        const dependencyLayer = sourceLayer(dependency);

        if (forbiddenLayers.has(dependencyLayer)) {
          violations.push(
            `${sourcePath(file)} -> ${sourcePath(dependency)}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("keeps implementations independent from legacy codegen facades", () => {
    const implementationLayers = new Set(["frontend", "analysis", "backend"]);
    const violations: string[] = [];

    for (const file of sourceFiles) {
      if (!implementationLayers.has(sourceLayer(file))) {
        continue;
      }

      const source = readFileSync(file, "utf8");

      for (const reference of collectModuleReferences(source)) {
        const dependency = resolveSourceModule(file, reference.specifier);

        if (dependency !== undefined && sourceLayer(dependency) === "codegen") {
          violations.push(
            `${sourcePath(file)} -> ${sourcePath(dependency)}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
