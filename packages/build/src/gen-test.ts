// Self-contained test SDK source (codec + tx + rpc + call + provider), inlined so a user's
// `bun test` runs with only the public @qubic-lib/qubic-ts-library — no qinit monorepo.
// The .qtmpl is embedded as text by `bun build --compile`.
// @ts-ignore - bun text import attribute (not typechecked against tsconfig)
import RUNTIME from "./assets/test-runtime.qtmpl" with { type: "text" };

export const testRuntimeSource: string = RUNTIME as unknown as string;

// A starter bun:test spec for the counter template (overwritten only if no test exists).
export function sampleTest(name: string): string {
  return `import { test, expect, beforeAll } from "bun:test";
import { ${name}, provider, settle } from "./.qinit";

let c: ${name};
beforeAll(() => { c = new ${name}(provider()); });

test("${name}: starts at zero and increments", async () => {
  expect((await c.Get()).value).toBe(0n);
  await c.Inc();          // procedure: signed tx ~8 ticks ahead
  await settle();         // wait past the offset so the tick is processed
  expect((await c.Get()).value).toBe(1n);
}, 60000);                // procedures are tick-bound — give them room (qinit test passes --timeout too)
`;
}
