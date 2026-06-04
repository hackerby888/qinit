// Self-contained test SDK source (codec + tx + rpc + call + provider), inlined so a user's
// `bun test` runs with only the public @qubic-lib/qubic-ts-library — no qinit monorepo.
// The .qtmpl is embedded as text by `bun build --compile`.
// @ts-ignore - bun text import attribute (not typechecked against tsconfig)
import RUNTIME from "./assets/test-runtime.qtmpl" with { type: "text" };

export const testRuntimeSource: string = RUNTIME as unknown as string;

// A starter bun:test spec for the counter template (overwritten only if no test exists).
export function sampleTest(name: string): string {
  return `import { test, expect, beforeAll } from "bun:test";
import { ${name}, provider } from "./.qinit";

let c: ${name};
beforeAll(() => { c = new ${name}(provider()); });

test("${name}: starts at zero and increments", async () => {
  expect((await c.Get()).value).toBe(0n);
  const r = await c.Inc();   // auto-confirms via the tx-status RPC (resolves once processed)
  expect(r.confirmed).toBe(true);  // node gave an exact verdict (not a tick guess)
  expect(r.included).toBe(true);   // the tx actually landed on-chain
  expect((await c.Get()).value).toBe(1n);
}, 60000);                // procedures are tick-bound (confirm waits ~8 ticks); give them room
`;
}
