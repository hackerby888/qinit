// A relative advance that times out may already have run on the node, so the client must not re-send
// it. Absolute routes keep the retry: replaying them changes nothing.
import { test, expect, afterEach } from "bun:test";
import { LiteRpc } from "../../src/net/rpc/client";

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
