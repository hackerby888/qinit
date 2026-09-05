// EngineServer (server.ts) — the HTTP adapter. Spins it up on an ephemeral port over an VirtualNode and
// drives qubic-core-lite RPC routes: tick info, faucet balance, and contract query over HTTP.
import { test, expect, beforeAll } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { VirtualNode } from "../../src/transport";
import { EngineServer } from "../../src/server";
import { deriveIdentity, LiteRpc, TESTNET_FUNDED_SEEDS } from "@qinit/core";

beforeAll(async () => {
    await initK12();
});

// Start an EngineServer on an ephemeral port over a freshly-configured engine; returns its base URL + a stop fn.
async function serve(setup?: (e: VirtualNode) => void | Promise<void>): Promise<{ base: string; stop: () => void; engine: VirtualNode }> {
    const engine = new VirtualNode();
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

// The client asks for the prefixed route, which core-lite answers wrapped in an envelope; a client written
// against the older flat answer still finds tick and epoch at the top.
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
            message: "dynamic slot 1 is outside 29..32",
        });

        const systemAtDynamicSlot = await fetch(`${base}/live/v1/dev/deploy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                slot: 29,
                name: "QX",
                kind: "system",
                wasm: Buffer.from(await wasm("Counter29")).toString("base64"),
            }),
        });
        expect(systemAtDynamicSlot.status).toBe(400);
        expect(await systemAtDynamicSlot.json()).toMatchObject({
            ok: false,
            message: "system slot 29 is outside 1..28",
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
    const counter = await wasm("Counter29");
    try {
        await rpc.directDeploy(29, counter, "Resident");
        engine.sim.procedure(29, 1);
        const moduleBeforeRejection = engine.sim.contracts.get(29);
        const digestBeforeRejection = engine.sim.digest(29);

        const rejected = await fetch(`${base}/live/v1/dev/deploy`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                slot: 29,
                name: "Replacement",
                kind: "dynamic",
                wasm: Buffer.from(counter).toString("base64"),
            }),
        });

        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({
            ok: false,
            message: "slot 29 is occupied by 'Resident'",
        });
        expect(engine.slotOf("Resident")).toBe(29);
        expect(engine.slotOf("Replacement")).toBeUndefined();
        expect(engine.sim.contracts.get(29)).toBe(moduleBeforeRejection);
        expect(engine.sim.digest(29)).toBe(digestBeforeRejection);

        expect(await rpc.directDeploy(29, counter, "Resident")).toMatchObject({
            ok: true,
            slot: 29,
        });
        expect(engine.sim.digest(29)).toBe(digestBeforeRejection);
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
