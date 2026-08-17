// Workspace packages are imported by `@qinit/*` alias, never by relative path: relative cross-package
// imports break on file moves and hide package boundaries.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// Requiring a package name followed by /src/ matches both drifted shapes (../../packages/core/src/x,
// ../../../proto/src/x) without catching within-package or non-package targets.
const RELATIVE_PACKAGE_IMPORT = /from\s+"(?:\.\.\/)+(?:packages\/)?(?:build|cli|compiler|core|engine|proto)\/src\/[^"]*"/;

test("workspace packages are imported by @qinit alias, not relative path", () => {
    const offenders: string[] = [];

    for (const relativePath of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) {
        if (/(^|\/)(node_modules|dist|\.generated)\//.test(relativePath)) continue;

        const lines = readFileSync(resolve(root, relativePath), "utf8").split("\n");
        lines.forEach((line, index) => {
            if (RELATIVE_PACKAGE_IMPORT.test(line)) {
                offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
            }
        });
    }

    expect(offenders).toEqual([]);
});
