// advanceTo sizes each request from the last round trip, and turns a halted node's 503 into the fault's own words instead of a bare HTTP error.
import { expect, test } from "bun:test";
import { RpcTimeoutError, type LiteRpc } from "@qinit/core";
import { advanceChunk, advanceTo, settleAfterTimeout } from "../../src/commands/node/tick";

function fakeNode(epochLastTick: number) {
    const spans: number[] = [];
    let tick = 0;
    const rpc = {
        advanceTick: async (n: number) => {
            spans.push(n);
            tick = Math.min(tick + n, epochLastTick);
            return { from: tick - n, requested: n, target: tick, reached: tick, epochLastTick, cappedAtEpochEnd: false };
        },
    } as unknown as LiteRpc;
    return { rpc, spans };
}

test("advanceTo never asks for the whole distance in one request", async () => {
    const { rpc, spans } = fakeNode(100_000);

    const r = await advanceTo(rpc, 5000, 0, () => {});

    expect(r.cur).toBe(5000);
    expect(spans.length).toBeGreaterThan(1);
    expect(Math.max(...spans)).toBeLessThanOrEqual(2048);
    expect(spans.reduce((sum, n) => sum + n, 0)).toBe(5000);
});

test("advanceChunk reports the fault behind a 503 and passes other errors through", async () => {
    const halted = Object.assign(new Error("RPC GET /live/v1/dev/advance-tick → HTTP 503"), { status: 503 });
    const fault = {
        message: "abort(7)",
        phase: "transaction",
        failedTick: 42,
        failedEpoch: 1,
        lastFinalizedTick: 41,
        lastFinalizedEpoch: 1,
        slot: 30,
        kind: 1,
        entry: 4,
    };
    const rpc = { advanceTick: async () => Promise.reject(halted), faultInfo: async () => fault } as unknown as LiteRpc;

    await expect(advanceChunk(rpc, 5)).rejects.toThrow(/node halted: slot 30 proc#4 trapped abort\(0x7\) at tick 42/);

    const unreachable = { advanceTick: async () => Promise.reject(new Error("node unreachable")) } as unknown as LiteRpc;
    await expect(advanceChunk(unreachable, 5)).rejects.toThrow("node unreachable");
});

// A chunk whose request outlives the client budget has usually run on the node: the tick is followed instead.
test("advanceChunk follows the tick after a timed-out advance instead of failing", async () => {
    const ticks = [10, 25, 40, 40, 40];
    let reads = 0;
    const rpc = {
        advanceTick: async () => Promise.reject(new RpcTimeoutError("/live/v1/dev/advance-tick?n=134", 15000)),
        faultInfo: async () => Promise.reject(Object.assign(new Error("HTTP 404"), { status: 404 })),
        tickInfo: async () => ({ tick: ticks[Math.min(reads++, ticks.length - 1)] }),
        epochInfo: async () => ({ epoch: 1, tick: 40, initialTick: 0, epochLastTick: 2999, ticksLeft: 2959, duration: 3000 }),
    } as unknown as LiteRpc;

    const r = await settleAfterTimeout(rpc, 10, 134, 1);

    expect(r).toMatchObject({ from: 10, requested: 134, target: 144, reached: 40, epochLastTick: 2999, cappedAtEpochEnd: false });
    expect(await advanceChunk(rpc, 134, 10).then(() => "settled")).toBe("settled");
});

test("advanceTo keeps going through a timed-out chunk and reaches the target", async () => {
    let tick = 0;
    let timedOut = false;
    const rpc = {
        advanceTick: async (n: number) => {
            tick += n;
            if (!timedOut) {
                timedOut = true;
                throw new RpcTimeoutError("/live/v1/dev/advance-tick", 15000);
            }
            return { from: tick - n, requested: n, target: tick, reached: tick, epochLastTick: 100_000, cappedAtEpochEnd: false };
        },
        faultInfo: async () => null,
        tickInfo: async () => ({ tick }),
        epochInfo: async () => ({ epoch: 1, tick, initialTick: 0, epochLastTick: 100_000, ticksLeft: 100_000 - tick, duration: 3000 }),
    } as unknown as LiteRpc;

    const r = await advanceTo(rpc, 300, 0, () => {});

    expect(r.cur).toBe(300);
    expect(timedOut).toBe(true);
});
