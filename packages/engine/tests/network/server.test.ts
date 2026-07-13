// EngineServer (server.ts) — the HTTP adapter. Spins it up on an ephemeral port over an VirtualNode and
// drives qubic-core-lite RPC routes: tick info, faucet balance, and contract query over HTTP.
import { test, expect, beforeAll } from "bun:test";
import { initK12 } from "../../src/k12";
import { VirtualNode } from "../../src/transport";
import { EngineServer } from "../../src/server";
import { deriveIdentity } from "@qinit/core";

const FIX = import.meta.dir + "/../fixtures";

beforeAll(async () => {
  await initK12();
});

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}

// Start an EngineServer on an ephemeral port over a freshly-configured engine; returns its base URL + a stop fn.
async function serve(
  setup?: (e: VirtualNode) => void | Promise<void>,
): Promise<{ base: string; stop: () => void; engine: VirtualNode }> {
  const engine = new VirtualNode();
  if (setup) {
    await setup(engine);
  }

  const server = new EngineServer(engine);
  const handle = await server.start(0);
  return { base: handle.rpcBase, stop: handle.stop, engine };
}

test("/tick-info reports the engine's tick + epoch", async () => {
  const { base, stop, engine } = await serve();
  try {
    const r = await fetch(`${base}/tick-info`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.epoch).toBe(engine.sim.epochN);
    expect(typeof j.tick).toBe("number");
  } finally {
    stop();
  }
});

test("the funded-seed faucet account is pre-funded", async () => {
  const { base, stop } = await serve();
  try {
    const seed = (await (await fetch(`${base}/live/v1/dev/funded-seed`)).json()).seed;
    expect(seed).toBe("a".repeat(55));

    const { identity } = await deriveIdentity(seed);
    const j = await (await fetch(`${base}/live/v1/balances/${identity}`)).json();
    expect(BigInt(j.balance.balance)).toBeGreaterThan(0n); // seedFaucet ran on start
  } finally {
    stop();
  }
});

test("querySmartContract runs a Counter function over HTTP", async () => {
  const { base, stop } = await serve(async (e) => {
    e.deploy(28, await wasm("Counter"));
    e.sim.procedure(28, 1); // Inc -> Get == 1
  });
  try {
    const r = await fetch(`${base}/live/v1/querySmartContract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractIndex: 28, inputType: 1, requestData: "" }),
    });
    expect(r.status).toBe(200);

    const out = Uint8Array.from(Buffer.from((await r.json()).responseData, "base64"));
    expect(new DataView(out.buffer, out.byteOffset, out.byteLength).getBigUint64(0, true)).toBe(1n);
  } finally {
    stop();
  }
});

test("contract-digest matches the engine's own digest; an unknown route 404s", async () => {
  const { base, stop, engine } = await serve(async (e) => {
    e.deploy(28, await wasm("Counter"));
  });
  try {
    const j = await (await fetch(`${base}/live/v1/dev/contract-digest?slot=28`)).json();
    expect(j.digest).toBe(engine.sim.digest(28));

    const r = await fetch(`${base}/no/such/route`);
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe(404);
  } finally {
    stop();
  }
});
