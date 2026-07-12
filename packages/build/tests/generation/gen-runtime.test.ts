// The runtime is generated directly from canonical source and embedded by a Bun macro. These tests retain the
// portability gate that protects generated clients from monorepo and node-only dependencies.
import { test, expect } from "bun:test";
import { generateRuntime } from "../../scripts/gen-runtime";
import { testRuntimeSource } from "../../src/gen-test";

test("the embedded test runtime is generated from the canonical source", async () => {
  const fresh = await generateRuntime();
  expect(testRuntimeSource).toBe(fresh);
}, 30_000);

test("the bundled runtime is portable: only @qubic-lib external, no node-only refs", async () => {
  const src = await generateRuntime();
  const externals = [...new Set([...src.matchAll(/from\s*"([^"]+)"|require\("([^"]+)"\)/g)].map((m) => m[1] || m[2]).filter((x) => x && !x.startsWith(".") && !x.startsWith("/")))];
  expect(externals.every((x) => x.startsWith("@qubic-lib"))).toBe(true);
  expect(/\bnode:|child_process|require\("fs"\)/.test(src)).toBe(false);
});
