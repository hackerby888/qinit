// The runtime is generated directly from canonical source and embedded by a Bun macro. These tests retain the
// portability gate that protects generated clients from monorepo and node-only dependencies.
// Both go through generateRuntimeMacro (a spawned build) rather than an in-process Bun.build: that is the path
// production uses, and a nested in-process build cannot resolve the bundled crypto packages.
import { test, expect } from "bun:test";
import { generateRuntimeMacro } from "../../scripts/gen-runtime";
import { testRuntimeSource } from "../../src/generate/test-scaffold";

test("the embedded test runtime is generated from the canonical source", () => {
    expect(testRuntimeSource).toBe(generateRuntimeMacro());
}, 30_000);

test("the bundled runtime is portable: no externals at all, no node-only refs", () => {
    const src = generateRuntimeMacro();
    const externals = [
        ...new Set(
            [...src.matchAll(/from\s*"([^"]+)"|require\("([^"]+)"\)/g)].map((m) => m[1] || m[2]).filter((x) => x && !x.startsWith(".") && !x.startsWith("/")),
        ),
    ];
    expect(externals).toEqual([]);
    expect(/\bnode:|child_process|require\("fs"\)/.test(src)).toBe(false);
}, 30_000);
