// EngineServer (server.ts) — the HTTP adapter, driven over an ephemeral port against core-lite RPC routes: tick info, faucet balance, and contract query.
import { test, expect, beforeAll } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { TEST_SLOT_LAYOUT } from "../../../../test-utils/slot-layout";
import { initK12 } from "../../src/support/k12";
import { VirtualNode } from "../../src/transport";
import { LOG_SC_INITIALIZE } from "../../src/logging/qubic-log-store";
import { EngineServer } from "../../src/server";
import { deriveIdentity, LiteRpc, TESTNET_FUNDED_SEEDS } from "@qinit/core";

// The dynamic window comes from the live core headers, as a node's does; no test spells a dynamic slot number.
const { slotBase, slotCount } = TEST_SLOT_LAYOUT;

beforeAll(async () => {
    await initK12();
});

// Start an EngineServer on an ephemeral port over a freshly-configured engine; returns its base URL + a stop fn.
async function serve(setup?: (e: VirtualNode) => void | Promise<void>): Promise<{ base: string; stop: () => void; engine: VirtualNode }> {
    const engine = new VirtualNode(TEST_SLOT_LAYOUT);
    if (setup) {
        await setup(engine);
    }

    const server = new EngineServer(engine);
    const handle = await server.start(0);
    return {
        base: handle.rpcBaseUrl,
        stop: handle.stop,
        engine,
    };
}

test("/tick-info reports the engine's tick + epoch", async () => {
    const { base, stop, engine } = await serve();
    try {
        const r = await fetch(`${base}/tick-info`);
        expect(r.status).toBe(200);
        const j = await r.json();
        expect(j.epoch).toBe(engine.sim.currentEpoch);
        expect(typeof j.tick).toBe("number");
        expect(await new LiteRpc(base).faultInfo()).toBeNull();
    } finally {
        stop();
    }
});

// The client asks for the prefixed route, which core-lite answers wrapped in an envelope; a client written against the older flat answer still finds both.
test("/live/v1/tick-info carries core-lite's envelope and keeps the flat keys", async () => {
    const { base, stop, engine } = await serve();
    try {
        const [prefixed, bare] = await Promise.all([fetch(`${base}/live/v1/tick-info`), fetch(`${base}/tick-info`)]);

        expect(prefixed.status).toBe(200);
        const flat = await bare.json();
        expect(await prefixed.json()).toEqual({
            ...flat,
            tickInfo: { tick: flat.tick, epoch: flat.epoch, initialTick: engine.epochInfo().initialTick, duration: 0 },
            alignedVotes: 0,
            misalignedVotes: 0,
            mainAuxStatus: 3,
        });
        expect((await new LiteRpc(base).tickInfo()).tick).toBe(flat.tick);
    } finally {
        stop();
    }
});

test("/live/v1/whoami identifies the simulator", async () => {
    const { base, stop } = await serve();
    try {
        const response = await fetch(`${base}/live/v1/whoami`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ backend: "simulator" });
        expect(await new LiteRpc(base).whoami()).toEqual({
            backend: "simulator",
        });
    } finally {
        stop();
    }
});

test("direct deploy enforces dynamic and system slot ranges", async () => {
    const { base, stop } = await serve();
    const rpc = new LiteRpc(base);
    try {
        const dynamicAtSystemSlot = await fetch(`${base}/live/v1/dev/deploy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                slot: 1,
                name: "Counter",
                wasm: Buffer.from(await wasm("Counter1")).toString("base64"),
            }),
        });
        expect(dynamicAtSystemSlot.status).toBe(400);
        expect(await dynamicAtSystemSlot.json()).toMatchObject({
            ok: false,
            message: `dynamic slot 1 is outside ${slotBase}..${slotBase + slotCount - 1}`,
        });

        const systemAtDynamicSlot = await fetch(`${base}/live/v1/dev/deploy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                slot: slotBase,
                name: "QX",
                kind: "system",
                wasm: Buffer.from(await wasm("CounterDyn0")).toString("base64"),
            }),
        });
        expect(systemAtDynamicSlot.status).toBe(400);
        expect(await systemAtDynamicSlot.json()).toMatchObject({
            ok: false,
            message: `system slot ${slotBase} is outside 1..${slotBase - 1}`,
        });

        expect(await rpc.directDeploy(1, await wasm("Counter1"), "QX", "system")).toMatchObject({
            ok: true,
            slot: 1,
        });
    } finally {
        stop();
    }
});

test("direct deploy rejects a different-name replacement without changing state", async () => {
    const { base, stop, engine } = await serve();
    const rpc = new LiteRpc(base);
    const counter = await wasm("CounterDyn0");
    try {
        await rpc.directDeploy(slotBase, counter, "Resident");
        engine.sim.procedure(slotBase, 1);
        const moduleBeforeRejection = engine.sim.contracts.get(slotBase);
        const digestBeforeRejection = engine.sim.digest(slotBase);

        const rejected = await fetch(`${base}/live/v1/dev/deploy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                slot: slotBase,
                name: "Replacement",
                kind: "dynamic",
                wasm: Buffer.from(counter).toString("base64"),
            }),
        });

        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({
            ok: false,
            message: `slot ${slotBase} is occupied by 'Resident'`,
        });
        expect(engine.slotOf("Resident")).toBe(slotBase);
        expect(engine.slotOf("Replacement")).toBeUndefined();
        expect(engine.sim.contracts.get(slotBase)).toBe(moduleBeforeRejection);
        expect(engine.sim.digest(slotBase)).toBe(digestBeforeRejection);

        expect(await rpc.directDeploy(slotBase, counter, "Resident")).toMatchObject({
            ok: true,
            slot: slotBase,
        });
        expect(engine.sim.digest(slotBase)).toBe(digestBeforeRejection);
    } finally {
        stop();
    }
});

test("the funded-seed faucet account is pre-funded", async () => {
    const { base, stop } = await serve();
    try {
        const seed = (await (await fetch(`${base}/live/v1/dev/funded-seed`)).json()).seed;
        expect(seed).toBe(TESTNET_FUNDED_SEEDS[0]); // the seed a testnet node funds too, so it works on either

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
        expect(j.slot).toBe(28);
        expect(j.stateSize).toBe(engine.sim.contracts.get(28)?.stateSize);

        const r = await fetch(`${base}/no/such/route`);
        expect(r.status).toBe(404);
        expect((await r.json()).code).toBe(404);
    } finally {
        stop();
    }
});

test("a contract fault stops ticking but keeps postmortem routes available", async () => {
    const engine = new VirtualNode();
    engine.deploy(28, await wasm("Trap"));
    const server = new EngineServer(engine);
    const handle = await server.start(0, 20);

    try {
        const input = new Uint8Array(16);
        const data = new DataView(input.buffer);
        data.setBigUint64(0, 7n, true);
        data.setBigUint64(8, 0n, true);

        expect(() => engine.sim.procedure(28, 2, input)).toThrow();
        const fault = engine.sim.faultInfo()!;

        await Bun.sleep(60);
        expect(engine.sim.currentTick).toBe(fault.failedTick);

        const faultResponse = await fetch(`${handle.rpcBaseUrl}/live/v1/dev/fault`);
        expect(faultResponse.status).toBe(200);
        expect(await faultResponse.json()).toEqual(fault);
        expect(await new LiteRpc(handle.rpcBaseUrl).faultInfo()).toEqual(fault);

        const tickResponse = await fetch(`${handle.rpcBaseUrl}/tick-info`);
        expect(tickResponse.status).toBe(200);
        expect(await tickResponse.json()).toMatchObject({
            tick: fault.lastFinalizedTick,
            epoch: fault.lastFinalizedEpoch,
            fault: {
                phase: fault.phase,
                failedTick: fault.failedTick,
                lastFinalizedTick: fault.lastFinalizedTick,
            },
        });

        const stateResponse = await fetch(`${handle.rpcBaseUrl}/live/v1/dev/state-read?slot=28&len=8`);
        expect(stateResponse.status).toBe(200);

        const historyResponse = await fetch(`${handle.rpcBaseUrl}/query/v1/getTransactionsForTick`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tick: fault.lastFinalizedTick }),
        });
        expect(historyResponse.status).toBe(200);

        const currentStateResponse = await fetch(`${handle.rpcBaseUrl}/live/v1/balances/ignored-after-fault`);
        expect(currentStateResponse.status).toBe(503);

        const queryResponse = await fetch(`${handle.rpcBaseUrl}/live/v1/querySmartContract`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                contractIndex: 28,
                inputType: 1,
                requestData: "",
            }),
        });
        expect(queryResponse.status).toBe(503);

        const advanceResponse = await fetch(`${handle.rpcBaseUrl}/live/v1/dev/advance-tick`);
        expect(advanceResponse.status).toBe(503);

        const unknownResponse = await fetch(`${handle.rpcBaseUrl}/unknown`);
        expect(unknownResponse.status).toBe(404);
    } finally {
        handle.stop();
    }
});

test("/live/v1/querySmartContract answers a function abort with core's 500 envelope and keeps serving", async () => {
    await initK12();
    const { base, stop } = await serve(async (e) => {
        e.deploy(28, await wasm("FaultZoo"));
    });
    try {
        const query = (n: bigint) => {
            const input = new Uint8Array(8);
            new DataView(input.buffer).setBigUint64(0, n, true);
            return fetch(`${base}/live/v1/querySmartContract`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ contractIndex: 28, inputType: 1, inputSize: 8, requestData: Buffer.from(input).toString("base64") }),
            });
        };

        const failed = await query(50n);
        expect(failed.status).toBe(500);
        expect(await failed.json()).toMatchObject({ code: -1, message: expect.stringMatching(/^Error calling smart contract function: abort\(/) });

        const fine = await query(5n);
        expect(fine.status).toBe(200);
        expect(await (await fetch(`${base}/live/v1/dev/fault`)).json()).toBeNull();
    } finally {
        stop();
    }
});

test("/live/v1/dyn-registry reports each slot's fee reserve as decimal text", async () => {
    const server = new EngineServer();
    server.engine.deploy(28, await wasm("Counter"), "Counter");
    const handle = await server.start(0);
    try {
        const registry = async () =>
            (await (await fetch(handle.rpcBaseUrl + "/live/v1/dyn-registry")).json()) as { contracts: { index: number; feeReserve?: string }[] };
        const seeded = (await registry()).contracts.find((entry) => entry.index === 28)!;
        expect(seeded.feeReserve).toBe(server.engine.feeReserve(28).toString());
        expect(BigInt(seeded.feeReserve!)).toBeGreaterThan(0n);

        server.engine.setContractFeeReserve(28, -5n);
        expect((await registry()).contracts.find((entry) => entry.index === 28)!.feeReserve).toBe("-5");
    } finally {
        handle.stop();
    }
});

// A little-endian u64 state image, the shape every Counter fixture's first field has.
function counterState(value: bigint, sizeBytes = 8): Uint8Array {
    const bytes = new Uint8Array(sizeBytes);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

test("a staged state seeds the next deploy of the slot and is gone afterwards", async () => {
    const { base, stop, engine } = await serve();
    const rpc = new LiteRpc(base);
    const counter = await wasm("CounterDyn0");
    const seed = counterState(41n);
    try {
        // two ordered chunks, as the CLI sends a large file
        expect(await rpc.stageState(slotBase, 0, seed.length, seed.subarray(0, 3))).toMatchObject({ ok: true, received: 3, total: 8 });
        expect(await rpc.stageState(slotBase, 3, seed.length, seed.subarray(3))).toMatchObject({ ok: true, received: 8, total: 8 });

        await rpc.directDeploy(slotBase, counter, "Seeded");
        expect(engine.sim.contracts.get(slotBase)!.state()).toEqual(seed);

        engine.sim.procedure(slotBase, 1);
        expect(engine.sim.contracts.get(slotBase)!.state()).toEqual(counterState(42n));

        // the entry was consumed: a redeploy carries the live state over instead of reseeding 41
        await rpc.directDeploy(slotBase, counter, "Seeded");
        expect(engine.sim.contracts.get(slotBase)!.state()).toEqual(counterState(42n));
    } finally {
        stop();
    }
});

test("a staged state of the wrong size fails the deploy and leaves the resident contract alone", async () => {
    const { base, stop, engine } = await serve();
    const rpc = new LiteRpc(base);
    const counter = await wasm("CounterDyn0");
    try {
        await rpc.directDeploy(slotBase, counter, "Resident");
        engine.sim.procedure(slotBase, 1);
        const residentModule = engine.sim.contracts.get(slotBase);
        const residentDigest = engine.sim.digest(slotBase);

        await rpc.stageState(slotBase, 0, 5, new Uint8Array(5));
        await expect(rpc.directDeploy(slotBase, counter, "Resident")).rejects.toThrow("initial state is 5 B");
        expect(engine.sim.contracts.get(slotBase)).toBe(residentModule);
        expect(engine.sim.digest(slotBase)).toBe(residentDigest);
        expect(await (await fetch(`${base}/live/v1/dev/fault`)).json()).toBeNull();

        // the failed deploy consumed the bad entry, so the next one is an ordinary carry-over
        await rpc.directDeploy(slotBase, counter, "Resident");
        expect(engine.sim.digest(slotBase)).toBe(residentDigest);
    } finally {
        stop();
    }
});

test("a staged state of the OldStateData size runs MIGRATE on a fresh slot", async () => {
    const { stop, engine } = await serve();
    try {
        expect(engine.stageState(28, 0, 8, counterState(7n))).toMatchObject({ ok: true, received: 8 });
        engine.deploy(28, await wasm("CounterV2"), "Counter");

        const migrated = new DataView(engine.sim.contracts.get(28)!.state().buffer);
        expect(migrated.getBigUint64(0, true)).toBe(7n);
    } finally {
        stop();
    }
});

test("state-stage rejects unordered chunks, overruns and oversize totals, and a zero total clears", async () => {
    const { base, stop, engine } = await serve();
    const rpc = new LiteRpc(base);
    try {
        await rpc.stageState(slotBase, 0, 8, new Uint8Array(4));
        await expect(rpc.stageState(slotBase, 6, 8, new Uint8Array(2))).rejects.toThrow("out of order; expected 4");
        await expect(rpc.stageState(slotBase, 4, 8, new Uint8Array(5))).rejects.toThrow("overruns the 8 B total");
        await expect(rpc.stageState(slotBase, 0, 2 * 1024 * 1024 * 1024, new Uint8Array(1))).rejects.toThrow("is outside 0..");
        await expect(rpc.stageState(slotBase + slotCount, 0, 8, new Uint8Array(8))).rejects.toThrow("is outside 1..");

        // a half-staged entry never seeds a deploy
        await rpc.directDeploy(slotBase, await wasm("CounterDyn0"), "Fresh");
        const freshState = engine.sim.contracts.get(slotBase)!.state();

        await rpc.stageState(slotBase + 1, 0, 8, counterState(9n));
        expect(await rpc.stageState(slotBase + 1, 0, 0, new Uint8Array(0))).toMatchObject({ ok: true, received: 0, total: 0 });
        await rpc.directDeploy(slotBase + 1, await wasm("CounterDyn1"), "Cleared");
        expect(engine.sim.contracts.get(slotBase + 1)!.state()).toEqual(freshState);
    } finally {
        stop();
    }
});

test("a seeded deploy skips INITIALIZE", async () => {
    const { stop, engine } = await serve();
    const probe = await wasm("DigestProbeDyn0");
    try {
        const initialized = engine.deploy(slotBase, probe, "Probe").state();
        expect(initialized.some((byte) => byte !== 0)).toBe(true);
        engine.undeploy(slotBase);

        engine.stageState(slotBase, 0, initialized.length, new Uint8Array(initialized.length));
        const seeded = engine.deploy(slotBase, probe, "Probe").state();
        expect(seeded.every((byte) => byte === 0)).toBe(true);
    } finally {
        stop();
    }
});

test("state-bytes serves the same bytes state-read spells in hex, and an unknown slot an empty body", async () => {
    const { base, stop, engine } = await serve();
    const rpc = new LiteRpc(base);
    try {
        await rpc.stageState(slotBase, 0, 8, counterState(5n));
        await rpc.directDeploy(slotBase, await wasm("CounterDyn0"), "Seeded");

        const response = await fetch(`${base}/live/v1/dev/state-bytes?slot=${slotBase}&off=2&len=4`);
        expect(response.headers.get("content-type")).toBe("application/octet-stream");
        expect(response.headers.get("x-state-size")).toBe("8");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(counterState(5n).slice(2, 6));

        expect(await rpc.stateBytes(slotBase, 0, 64)).toEqual({ bytes: engine.sim.contracts.get(slotBase)!.state(), stateSize: 8 });
        expect(await rpc.stateBytes(slotBase + 1, 0, 8)).toEqual({ bytes: new Uint8Array(0), stateSize: 0 });
    } finally {
        stop();
    }
});

// A core node arms a slot in the DEPLOY's tick and runs INITIALIZE or MIGRATE at the head of the next one; a deploy that arrives over a route does the same.
test("a routed deploy is armed at once and constructed at the next tick, in the INITIALIZE log range", async () => {
    const engine = new VirtualNode({ slotBase: 28, slotCount: 4 });
    // An interval the test never reaches, so every tick here is one the test takes itself.
    const handle = await new EngineServer(engine).start(0, 3_600_000);
    const rpc = new LiteRpc(handle.rpcBaseUrl);
    const seen = () => {
        const output = engine.sim.query(28, 1);
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        return [view.getBigUint64(0, true), view.getBigUint64(8, true)];
    };
    try {
        const deployTick = engine.sim.currentTick;
        await rpc.directDeploy(28, await wasm("InitWitness"), "InitWitness", "dynamic");

        expect((await rpc.dynRegistry()).contracts.find((contract) => contract.index === 28)).toMatchObject({ armed: true, constructed: false });
        // A call in the deploy's own tick runs, against state INITIALIZE has not touched yet.
        expect(seen()).toEqual([0n, 0n]);

        engine.sim.advance();
        expect((await rpc.dynRegistry()).contracts.find((contract) => contract.index === 28)?.constructed).toBe(true);
        expect(seen()).toEqual([0x494e495445444e45n, BigInt(deployTick + 1)]);
        expect(engine.logger.range(deployTick + 1, LOG_SC_INITIALIZE).length).toBe(1n);

        engine.sim.advance();
        expect(seen()[1]).toBe(BigInt(deployTick + 1));
    } finally {
        handle.stop();
    }
});

test("a routed upgrade defers its MIGRATE the same way, and an embedder's own deploy still constructs at once", async () => {
    const engine = new VirtualNode({ slotBase: 28, slotCount: 4 });
    // An interval the test never reaches, so every tick here is one the test takes itself.
    const handle = await new EngineServer(engine).start(0, 3_600_000);
    const rpc = new LiteRpc(handle.rpcBaseUrl);
    const counter = () => new DataView(engine.sim.contracts.get(28)!.state().buffer).getBigUint64(0, true);
    try {
        engine.deploy(28, await wasm("Counter"), "Counter");
        expect((await rpc.dynRegistry()).contracts.find((contract) => contract.index === 28)?.constructed).toBe(true);
        engine.sim.procedure(28, 1);
        engine.sim.procedure(28, 1);
        expect(counter()).toBe(2n);

        await rpc.directDeploy(28, await wasm("CounterV2"), "Counter", "dynamic");
        expect((await rpc.dynRegistry()).contracts.find((contract) => contract.index === 28)?.constructed).toBe(false);
        expect(counter()).toBe(0n);

        engine.sim.advance();
        expect((await rpc.dynRegistry()).contracts.find((contract) => contract.index === 28)?.constructed).toBe(true);
        expect(counter()).toBe(2n);
    } finally {
        handle.stop();
    }
});
