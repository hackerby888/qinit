import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));

// The two bundler entry points. Everything else belongs to a layer directory, so the src root cannot
// become a dumping ground the layer rules below are structurally unable to police.
const ROOT_ENTRIES = new Set(["index.ts", "browser.ts"]);

// Lowest first. `generated` holds committed build artefacts and depends on nothing.
const LAYERS = [
    "generated",
    "shared",
    "ast",
    "frontend",
    "analysis",
    "backend",
    "driver",
    "analyzer",
];

const FORBIDDEN_LAYER_IMPORTS: Record<string, Set<string>> = Object.fromEntries(
    LAYERS.map((layer, index) => [layer, new Set(LAYERS.slice(index + 1))]),
);

// Cross-layer cycles are the ones that matter; the type-only cycles inside a single layer are the
// established `*-context.ts` pattern, where a split class hands itself back to its own parts.
const MAX_FILE_LINES = 750;

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

// A root entry file has no layer of its own; it is allowed to reach into any of them.
function sourceLayer(path: string): string | undefined {
    const segments = sourcePath(path).split("/");
    return segments.length > 1 ? segments[0] : undefined;
}

function collectModuleReferences(source: string): ModuleReference[] {
    const references: ModuleReference[] = [];
    const importPattern = /\bimport\s+(type\s+)?(?:(?:[\w$*,\s{}]+)\s+from\s+)?["']([^"']+)["']/g;
    const exportPattern =
        /\bexport\s+(type\s+)?(?:\*\s*(?:as\s+[\w$]+\s+)?|\{[^}]*\}\s*)from\s+["']([^"']+)["']/g;

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
    const candidates = [basePath, `${basePath}.ts`, resolve(basePath, "index.ts")];

    return candidates.find((candidate) => {
        return existsSync(candidate) && statSync(candidate).isFile();
    });
}

function buildGraph(files: string[], includeTypeOnly: boolean): Map<string, string[]> {
    const graph = new Map<string, string[]>();

    for (const file of files) {
        const source = readFileSync(file, "utf8");
        const dependencies = collectModuleReferences(source)
            .filter((reference) => includeTypeOnly || !reference.typeOnly)
            .map((reference) => resolveSourceModule(file, reference.specifier))
            .filter((dependency): dependency is string => dependency !== undefined);

        graph.set(file, dependencies);
    }

    return graph;
}

function findCycles(graph: Map<string, string[]>): string[][] {
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

    test("keeps runtime dependencies acyclic", () => {
        const cycles = findCycles(buildGraph(sourceFiles, false)).map((cycle) => {
            return cycle.map(sourcePath);
        });

        expect(cycles).toEqual([]);
    });

    test("keeps type-only cycles inside a single layer", () => {
        const crossLayer = findCycles(buildGraph(sourceFiles, true))
            .filter((cycle) => new Set(cycle.map(sourceLayer)).size > 1)
            .map((cycle) => cycle.map(sourcePath));

        expect(crossLayer).toEqual([]);
    });

    test("keeps the source root free of anything but the bundler entry points", () => {
        const strays = sourceFiles
            .map(sourcePath)
            .filter((path) => !path.includes("/") && !ROOT_ENTRIES.has(path));

        expect(strays).toEqual([]);
    });

    test("keeps every source file in a known layer", () => {
        const unknown = sourceFiles
            .map(sourcePath)
            .filter((path) => path.includes("/") && !LAYERS.includes(path.split("/")[0]));

        expect(unknown).toEqual([]);
    });

    test("keeps files small enough to read in one sitting", () => {
        const oversized = sourceFiles
            .map((file) => ({
                path: sourcePath(file),
                lines: readFileSync(file, "utf8").split("\n").length,
            }))
            // The generated QPI snapshot is one enormous embedded string, not code anyone reads.
            .filter((file) => file.lines > MAX_FILE_LINES && !file.path.startsWith("generated/"))
            .map((file) => `${file.path} (${file.lines} lines)`);

        expect(oversized).toEqual([]);
    });

    test("keeps dependencies pointed toward lower compiler layers", () => {
        const violations: string[] = [];

        for (const file of sourceFiles) {
            const importerLayer = sourceLayer(file);

            if (importerLayer === undefined) {
                continue;
            }

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

                if (dependencyLayer !== undefined && forbiddenLayers.has(dependencyLayer)) {
                    violations.push(`${sourcePath(file)} -> ${sourcePath(dependency)}`);
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
