// A relative advance that times out may already have run, so the client must not re-send it; absolute routes keep the retry since replaying changes nothing.
import { test, expect, afterEach } from "bun:test";
import { ADVANCE_EPOCH_TIMEOUT_MS, ADVANCE_TICK_TIMEOUT_MS, LiteRpc, RpcTimeoutError } from "../../src/net/rpc/client";
import { RequestTimeoutError } from "../../src/net/http";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

function unreachableNode(): Record<string, number> {
    const calls: Record<string, number> = {};
    globalThis.fetch = (async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        calls[path] = (calls[path] ?? 0) + 1;
        throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    return calls;
}

test("advance-tick and advance-epoch are sent once, tick-info is retried", async () => {
    const calls = unreachableNode();
    const rpc = new LiteRpc("http://127.0.0.1:1");

    await expect(rpc.advanceTick(2260)).rejects.toThrow(/node unreachable/);
    await expect(rpc.advanceEpoch()).rejects.toThrow(/node unreachable/);
    await expect(rpc.tickInfo()).rejects.toThrow(/node unreachable/);

    expect(calls["/live/v1/dev/advance-tick"]).toBe(1);
    expect(calls["/live/v1/dev/advance-epoch"]).toBe(1);
    expect(calls["/live/v1/tick-info"]).toBe(3);
});

test("a timed-out advance is reported as a timeout, not as an unreachable node", async () => {
    const calls: Record<string, number> = {};
    globalThis.fetch = (async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        calls[path] = (calls[path] ?? 0) + 1;
        throw new RequestTimeoutError(String(url), 15000);
    }) as unknown as typeof fetch;
    const rpc = new LiteRpc("http://127.0.0.1:1");

    const error = await rpc.advanceTick(134).catch((e) => e);
    expect(error).toBeInstanceOf(RpcTimeoutError);
    expect(error.message).toContain("may still be working");
    expect(error.message).not.toContain("unreachable");
    expect(calls["/live/v1/dev/advance-tick"]).toBe(1);

    await expect(rpc.advanceEpoch()).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(rpc.tickInfo()).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(calls["/live/v1/tick-info"]).toBe(3);
});

test("the advance routes get budgets above core-lite's own fast-forward caps", () => {
    expect(ADVANCE_TICK_TIMEOUT_MS).toBeGreaterThan(12000);
    expect(ADVANCE_EPOCH_TIMEOUT_MS).toBeGreaterThan(25000);
});
