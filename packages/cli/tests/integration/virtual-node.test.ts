// The virtualnode backend that `qinit node run` boots under `qinit mode virtualnode`: an EngineServer the CLI
// talks to over its OWN client surface — LiteRpc (@qinit/core) + the proto call helpers (callFunction /
import { test, expect, beforeAll } from "bun:test";
import { EngineServer } from "@qinit/engine/server";
import { initK12, LiteRpc, deriveIdentity } from "@qinit/core";
import { callFunction, invokeProcedure, TX_TICK_OFFSET } from "@qinit/proto";
import { portFromRpc } from "../../src/serve";

const FIX = import.meta.dir + "/../../../engine/tests/fixtures";
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
async function bootCounter() {
  const wasm = new Uint8Array(await Bun.file(`${FIX}/Counter.wasm`).arrayBuffer());
  const srv = new EngineServer();
  srv.engine.deploy(SLOT, wasm);
  const h = await srv.start(0);
  return { rpc: new LiteRpc(h.rpcBase), rpcBase: h.rpcBase, stop: h.stop, engine: srv.engine };
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
      seed: SEED,
      rpcBase,
      contractIndex: SLOT,
      procId: INC,
      amount: 0,
      inFmt: "",
      tick,
      confirm: true,
      rpc,
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

test("confirm waits for execution: a read right after confirm sees the mutation (no poll)", async () => {
  // Regression: txStatus.processed used to be hard-true on broadcast, so confirm() returned before the tx's
  // tick ran and a read right after saw stale state — which broke the default `await proc(); read()` sample.
  const { rpc, rpcBase, stop } = await bootCounter();
  try {
    const ti = await rpc.tickInfo();
    const tick = ((ti.tick ?? 0) as number) + TX_TICK_OFFSET;
    const r = await invokeProcedure({
      seed: SEED,
      rpcBase,
      contractIndex: SLOT,
      procId: INC,
      amount: 0,
      inFmt: "",
      tick,
      confirm: true,
      rpc,
    });
    expect(r.confirmed).toBe(true);
    // no poll loop: confirm must not resolve until the tx's tick executed, so the Inc is already visible
    expect(BigInt(await callFunction(rpc, SLOT, GET, "", "uint64"))).toBe(1n);
  } finally {
    stop();
  }
});

test("funded-seeds returns a pool of spendable seeds (qinit seed)", async () => {
  const { rpc, stop } = await bootCounter();
  try {
    const r = await rpc.fundedSeeds(32);
    expect(r.count).toBe(16);
    expect(r.seeds[0]).toBe(SEED); // pool[0] = the universal default "a"*55
    // every returned seed must be a real, funded account — not just listed
    for (const seed of r.seeds) {
      const { identity } = await deriveIdentity(seed);
      const info = await rpc.balance(identity);
      expect(BigInt(info.balance)).toBeGreaterThan(0n);
    }
  } finally {
    stop();
  }
});

test("epoch-info reports a coherent tick window (qinit tick / epoch)", async () => {
  const { rpc, engine, stop } = await bootCounter();
  try {
    const e = await rpc.epochInfo();
    expect(e.duration).toBe(engine.sim.epochLength);
    expect(e.tick).toBeGreaterThanOrEqual(e.initialTick);
    expect(e.tick).toBeLessThanOrEqual(e.epochLastTick);
    expect(e.ticksLeft).toBe(e.epochLastTick - e.tick);
  } finally {
    stop();
  }
});

test("advance-tick caps at the epoch's last tick (qinit tick advance)", async () => {
  const { rpc, engine, stop } = await bootCounter();
  try {
    engine.sim.epochLength = 50; // keep the boundary near so the cap is reached without ticking 3000×
    const e = await rpc.epochInfo();
    const r = await rpc.advanceTick(10_000_000);
    expect(r.cappedAtEpochEnd).toBe(true);
    expect(r.reached).toBeLessThanOrEqual(e.epochLastTick);
    expect(r.epochLastTick).toBe(e.epochLastTick);
  } finally {
    stop();
  }
});

test("advance-epoch crosses into the next epoch (qinit epoch advance)", async () => {
  const { rpc, engine, stop } = await bootCounter();
  try {
    engine.sim.epochLength = 10; // small window so the boundary is near
    const r = await rpc.advanceEpoch();
    expect(r.switched).toBe(true);
    expect(r.toEpoch).toBe(r.fromEpoch + 1);
  } finally {
    stop();
  }
});

test("directDeploy arms an arbitrary (system-index) slot, runs, surfaces in registry, undeploys", async () => {
  const wasm = new Uint8Array(await Bun.file(`${FIX}/Counter1.wasm`).arrayBuffer());
  const srv = new EngineServer();
  const h = await srv.start(0);
  const rpc = new LiteRpc(h.rpcBase);
  try {
    const r = await rpc.directDeploy(1, wasm, "SYSISH"); // low index, like a system contract (outside [28,32))
    expect(r?.ok).toBe(true);
    expect(r?.slot).toBe(1);

    expect(BigInt(await callFunction(rpc, 1, GET, "", "uint64"))).toBe(0n); // runs at slot 1

    const reg = await rpc.dynRegistry();
    expect((reg.contracts ?? []).some((c) => c.index === 1 && c.armed)).toBe(true); // surfaced out-of-window

    expect(await rpc.undeploy(1)).toBe(true);
    expect(((await rpc.dynRegistry()).contracts ?? []).some((c) => c.index === 1)).toBe(false);
  } finally {
    h.stop();
  }
});

test("tick rate is adjustable on a running node, no respawn (qinit tick rate)", async () => {
  const { rpc, engine, stop } = await bootCounter();
  try {
    expect((await rpc.setTickMs(0)).tickMs).toBe(0); // 0 = fastest
    expect(engine.sim.tickDuration).toBe(0);
    expect((await rpc.setTickMs(250)).tickMs).toBe(250);
    expect(engine.sim.tickDuration).toBe(250); // live chain-clock step updated too
  } finally {
    stop();
  }
});
