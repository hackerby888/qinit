// hurryToTick latches off the dev advance-tick route only when the node says 404. A 5xx or a timeout is
// transient, and latching on those would leave the client on the slow path for the rest of its life.
import { test, expect, afterEach } from "bun:test";
import { LiteRpc } from "../../src/net/rpc/client";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

// Answers tick-info with `tick`, and the dev advance route with `advanceStatus`.
function mockNode(tick: number, advanceStatus: number): () => number {
    let advanceCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
        const path = String(url);
        if (path.includes("/dev/advance-tick")) {
            advanceCalls++;
            if (advanceStatus !== 200) {
                return new Response(JSON.stringify({ message: "nope" }), { status: advanceStatus });
            }
            return new Response(JSON.stringify({ reached: tick + 1, epochLastTick: tick + 100, cappedAtEpochEnd: false }));
        }
        return new Response(JSON.stringify({ tick }));
    }) as typeof fetch;
    return () => advanceCalls;
}

test("a 404 from the dev advance route stops further probes", async () => {
    const advanceCalls = mockNode(10, 404);
    const rpc = new LiteRpc("http://127.0.0.1:1");

    expect(await rpc.hurryToTick(12)).toBe(10);
    const afterFirst = advanceCalls();
    expect(afterFirst).toBe(1);

    // The route is gone for good, so the second call must not touch it again.
    expect(await rpc.hurryToTick(12)).toBe(0);
    expect(advanceCalls()).toBe(afterFirst);
});

test("a 503 from the dev advance route does not disable the fast path", async () => {
    const advanceCalls = mockNode(10, 503);
    const rpc = new LiteRpc("http://127.0.0.1:1");

    expect(await rpc.hurryToTick(12)).toBe(10);
    expect(advanceCalls()).toBe(1);

    // A transient failure must leave the probe armed for the next call.
    await rpc.hurryToTick(12);
    expect(advanceCalls()).toBe(2);
});

test("the dev advance route is used when the node answers", async () => {
    const advanceCalls = mockNode(10, 200);
    const rpc = new LiteRpc("http://127.0.0.1:1");

    expect(await rpc.hurryToTick(11)).toBe(11);
    expect(advanceCalls()).toBe(1);
});
