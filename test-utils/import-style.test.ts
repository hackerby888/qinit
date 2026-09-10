// Workspace packages are imported by `@qinit/*` alias, never relative path: relative cross-package imports break on moves and hide boundaries.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".generated", ".git"]);

// Requiring a package name followed by /src/ matches both drifted shapes without catching within-package or non-package targets.
const RELATIVE_PACKAGE_IMPORT = /from\s+"(?:\.\.\/)+(?:packages\/)?(?:build|cli|compiler|core|engine|proto)\/src\/[^"]*"/;

// Pruned before descending: walking node_modules first and filtering afterwards is what made this slow on Windows.
function* sourceFiles(dir: string, prefix = ""): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name), relativePath);
        } else if (/\.tsx?$/.test(entry.name)) {
            yield relativePath;
        }
    }
}

test(
    "workspace packages are imported by @qinit alias, not relative path",
    () => {
        const offenders: string[] = [];

        for (const relativePath of sourceFiles(root)) {
            const lines = readFileSync(resolve(root, relativePath), "utf8").split("\n");
            lines.forEach((line, index) => {
                if (RELATIVE_PACKAGE_IMPORT.test(line)) {
                    offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
                }
            });
        }

        expect(offenders).toEqual([]);
    },
    60_000,
);
