// The virtualnode backend that `qinit node run` boots under `qinit mode virtualnode`: an EngineServer the CLI
// talks to over its OWN client surface — LiteRpc (@qinit/core) + the proto call helpers (callFunction /
// invokeProcedure) that `qinit call` uses. Proves the in-process node ticks, serves reads, and processes signed
// procedure txs end-to-end — the path the CLI depends on, which the CLI's own tests didn't cover. Mirrors
// engine/tests/server.test.ts but exercises the CLI glue (LiteRpc + @qinit/proto) instead of raw fetch.
import { test, expect, beforeAll } from "bun:test";
import { EngineServer } from "@qinit/engine/server";
import { initK12, LiteRpc } from "@qinit/core";
import { callFunction, invokeProcedure, TX_TICK_OFFSET } from "@qinit/proto";
import { portFromRpc } from "../src/serve";

const FIX = import.meta.dir + "/../../engine/tests/fixtures";
const SEED = "a".repeat(55);
const SLOT = 28;
const GET = 1; // Counter function id: Get -> uint64 count
const INC = 1; // Counter procedure id: Inc

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await initK12();
});

// Boot the same backend launchVirtualNode spawns (EngineServer over the in-process engine) with Counter armed,
// on an ephemeral port; hand back the CLI's LiteRpc client + a stop fn.
async function bootCounter(): Promise<{ rpc: LiteRpc; rpcBase: string; stop: () => void }> {
  const wasm = new Uint8Array(await Bun.file(`${FIX}/Counter.wasm`).arrayBuffer());
  const srv = new EngineServer();
  srv.engine.deploy(SLOT, wasm);
  const h = await srv.start(0);
  return { rpc: new LiteRpc(h.rpcBase), rpcBase: h.rpcBase, stop: h.stop };
}

test("portFromRpc: parses the port, defaults to 41841", () => {
  expect(portFromRpc("http://127.0.0.1:54321")).toBe(54321);
  expect(portFromRpc("http://127.0.0.1")).toBe(41841);
});

test("the virtual node ticks (what `node run` waits on before deploying)", async () => {
  const { rpc, stop } = await bootCounter();
  try {
    const a = (await rpc.tickInfo()).tick ?? 0;
    await sleep(300);
    const b = (await rpc.tickInfo()).tick ?? 0;
    expect(b).toBeGreaterThan(a);
  } finally {
    stop();
  }
});

test("callFunction reads Counter state over the CLI's RPC client", async () => {
  const { rpc, stop } = await bootCounter();
  try {
    const count = await callFunction(rpc, SLOT, GET, "", "uint64");
    expect(BigInt(count)).toBe(0n);
  } finally {
    stop();
  }
});

test("invokeProcedure signs + broadcasts Inc; it processes and state advances", async () => {
  const { rpc, rpcBase, stop } = await bootCounter();
  try {
    const ti = await rpc.tickInfo();
    const tick = ((ti.tick ?? 0) as number) + TX_TICK_OFFSET;
    const r = await invokeProcedure({
      seed: SEED, rpcBase, contractIndex: SLOT, procId: INC, amount: 0, inFmt: "", tick, confirm: true, rpc,
    });
    expect(r.ok).toBe(true);
    expect(r.confirmed).toBe(true);
    expect(r.included).toBe(true);

    // txStatus is processed-on-broadcast for the single-authority engine, so poll the state until the Inc has
    // actually executed (the engine reaches the tx's tick) rather than racing it.
    let count = 0n;
    for (let i = 0; i < 40 && count !== 1n; i++) {
      count = BigInt(await callFunction(rpc, SLOT, GET, "", "uint64"));
      if (count !== 1n) {
        await sleep(50);
      }
    }
    expect(count).toBe(1n);
  } finally {
    stop();
  }
});
