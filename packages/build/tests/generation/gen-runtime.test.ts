// The runtime is generated from canonical source and embedded by a Bun macro; both tests go through generateRuntimeMacro, the path production uses.
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
