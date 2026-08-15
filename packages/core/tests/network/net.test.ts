// broadcastTx verdict logic + the response-body stall watchdog. broadcastTx must only report ok when the node
// actually accepted+relayed the tx (peers >= 1, no error code) — a false ok would hide a dropped tx.
import { test, expect, afterEach } from "bun:test";
import { DEFAULT_RPC_BASE, broadcastTx, readResponseBodyWithTimeout } from "../../src/net/http";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});
const mock = (o: unknown, status = 200) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(o), { status })) as any;
};
const tx = new Uint8Array([1, 2, 3]);

test("broadcastTx: ok only when peersBroadcasted >= 1 and no error code", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ peersBroadcasted: 3, transactionId: "abc" }));
    }) as typeof fetch;

    expect(await broadcastTx(tx)).toMatchObject({ ok: true, transactionId: "abc" });
    expect(requestedUrl).toBe(`${DEFAULT_RPC_BASE}/live/v1/broadcast-transaction`);
});

test("broadcastTx: not ok on an error code or zero peers", async () => {
    mock({ code: 5, message: "rejected", peersBroadcasted: 2 });
    expect((await broadcastTx(tx)).ok).toBe(false);
    mock({ peersBroadcasted: 0 });
    expect((await broadcastTx(tx)).ok).toBe(false);
});

test("broadcastTx: a fetch failure throws 'node unreachable'", async () => {
    globalThis.fetch = (async () => {
        throw new Error("ECONNREFUSED");
    }) as any;
    await expect(broadcastTx(tx, "http://127.0.0.1:1")).rejects.toThrow(/node unreachable/);
});

test("readResponseBodyWithTimeout: a stalled body stream aborts via the inactivity watchdog", async () => {
    const never = new ReadableStream<Uint8Array>({
        start() {
            /* never enqueue, never close */
        },
    });
    await expect(readResponseBodyWithTimeout(new Response(never), 100)).rejects.toThrow(/stalled/);
});

test("readResponseBodyWithTimeout: reads a normal body in full", async () => {
    expect([...(await readResponseBodyWithTimeout(new Response(new Uint8Array([5, 6, 7])), 1000))]).toEqual([5, 6, 7]);
});
