// Drift guard: the committed test-runtime.qtmpl must equal a fresh bundle of the real @qinit source. If this
// fails, the codec/tx/rpc changed but the SDK wasn't regenerated — run `bun packages/build/scripts/gen-runtime.ts`.
// This is what replaces the old hand-maintained mirror: the runtime can no longer silently diverge from qinit.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { generateRuntime, RUNTIME_QTMPL } from "../scripts/gen-runtime";

test("test-runtime.qtmpl is in sync with the real source (regenerate via gen-runtime.ts if this fails)", async () => {
  const fresh = await generateRuntime();
  const committed = readFileSync(RUNTIME_QTMPL, "utf8");
  expect(committed).toBe(fresh);
}, 30_000);

test("the bundled runtime is portable: only @qubic-lib external, no node-only refs", () => {
  const src = readFileSync(RUNTIME_QTMPL, "utf8");
  const externals = [...new Set([...src.matchAll(/from\s*"([^"]+)"|require\("([^"]+)"\)/g)].map((m) => m[1] || m[2]).filter((x) => x && !x.startsWith(".") && !x.startsWith("/")))];
  expect(externals.every((x) => x.startsWith("@qubic-lib"))).toBe(true);
  expect(/\bnode:|child_process|require\("fs"\)/.test(src)).toBe(false);
});
