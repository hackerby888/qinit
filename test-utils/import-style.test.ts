// Workspace packages are imported by `@qinit/*` alias, never by relative path. Relative cross-package
// imports break on file moves and hide package boundaries, and they had drifted into 17 files before this
// gate existed — including one that mixed both styles for the same package in a single import block.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Cannot reuse test-utils/paths.ts: importing it throws unless QINIT_CORE is set, and this gate must run
// on a bare checkout.
const root = resolve(import.meta.dir, "..");

// Both drifted shapes: `../../packages/core/src/x` (scripts, test-utils) and `../../../proto/src/x`
// (package-internal tests). Requiring a package name followed by `/src/` keeps within-package imports
// (`../../src/x`) and non-package targets (`../../../../test-utils/paths`) from matching.
const RELATIVE_PACKAGE_IMPORT =
    /from\s+"(?:\.\.\/)+(?:packages\/)?(?:build|cli|compiler|core|engine|proto)\/src\/[^"]*"/;

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
