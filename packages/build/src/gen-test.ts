// Self-contained test SDK source (codec + tx + rpc + call + provider), generated from the canonical sources
// and inlined by Bun while it bundles Qinit. The generated client therefore needs only the public @qubic-lib.
import { generateRuntimeMacro } from "../scripts/gen-runtime" with { type: "macro" };

export const testRuntimeSource: string = generateRuntimeMacro();

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
