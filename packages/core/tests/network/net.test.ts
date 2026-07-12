// broadcastTx verdict logic + the readBody stall watchdog. broadcastTx must only report ok when the node
// actually accepted+relayed the tx (peers >= 1, no error code) — a false ok would hide a dropped tx.
import { test, expect, afterEach } from "bun:test";
import { broadcastTx, readBody } from "../../src/net";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const mock = (o: unknown, status = 200) => { globalThis.fetch = (async () => new Response(JSON.stringify(o), { status })) as any; };
const tx = new Uint8Array([1, 2, 3]);

test("broadcastTx: ok only when peersBroadcasted >= 1 and no error code", async () => {
  mock({ peersBroadcasted: 3, transactionId: "abc" });
  expect(await broadcastTx(tx)).toMatchObject({ ok: true, transactionId: "abc" });
});

test("broadcastTx: not ok on an error code or zero peers", async () => {
  mock({ code: 5, message: "rejected", peersBroadcasted: 2 });
  expect((await broadcastTx(tx)).ok).toBe(false);
  mock({ peersBroadcasted: 0 });
  expect((await broadcastTx(tx)).ok).toBe(false);
});

test("broadcastTx: a fetch failure throws 'node unreachable'", async () => {
  globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
  await expect(broadcastTx(tx, "http://127.0.0.1:1")).rejects.toThrow(/node unreachable/);
});

test("readBody: a stalled body stream aborts via the inactivity watchdog", async () => {
  const never = new ReadableStream<Uint8Array>({ start() {/* never enqueue, never close */} });
  await expect(readBody(new Response(never), 100)).rejects.toThrow(/stalled/);
});

test("readBody: reads a normal body in full", async () => {
  expect([...(await readBody(new Response(new Uint8Array([5, 6, 7])), 1000))]).toEqual([5, 6, 7]);
});
