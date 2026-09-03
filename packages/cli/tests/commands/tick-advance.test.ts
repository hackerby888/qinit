// advanceTo sizes each request from the last one's round trip, and turns a halted node's 503 into the
// fault's own words instead of a bare HTTP error.
import { expect, test } from "bun:test";
import type { LiteRpc } from "@qinit/core";
import { advanceChunk, advanceTo } from "../../src/commands/node/tick";

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
