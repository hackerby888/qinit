// The oracle dev/test RPC seam: the virtual node has no real oracle machines, so a TS test must (a) discover the
// PENDING query a contract raised — a tx-raised query's id is never returned to the broadcaster — and (b) inject
import { test, expect } from "bun:test";
import { EngineServer } from "@qinit/engine/server";
import { initK12 } from "@qinit/core";

const FIX = import.meta.dir + "/../../../engine/tests/fixtures";
const QUERY = 2, LAST = 1; // OracleProbe: REGISTER_USER_PROCEDURE(Query,2) / REGISTER_USER_FUNCTION(Last,1)
const cid = (s: number) => { const a = new Uint8Array(32); new DataView(a.buffer).setBigUint64(0, BigInt(s), true); return a; };
const queryIn = (v: bigint, ms: number) => { const b = new Uint8Array(16); const dv = new DataView(b.buffer); dv.setBigUint64(0, v, true); dv.setUint32(8, ms, true); return b; };
const mockReply = (echoed: bigint, doubled: bigint) => { const b = new Uint8Array(16); const dv = new DataView(b.buffer); dv.setBigUint64(0, echoed, true); dv.setBigUint64(8, doubled, true); return b; };
const i64 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(0, true);
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

test("oracle RPC seam: discover a pending query, inject the reply, the notification fires", async () => {
  await initK12();
  const SLOT = 29;
  const srv = new EngineServer();
  srv.engine.deploy(SLOT, new Uint8Array(await Bun.file(`${FIX}/OracleProbe.wasm`).arrayBuffer()));
  srv.engine.sim.fund(cid(SLOT), 1_000_000n); // balance to burn for the query fee
  srv.engine.sim.procedure(SLOT, QUERY, queryIn(21n, 60_000)); // raise a PENDING query (id not visible to a tx sender)
  const h = await srv.start();
  try {
    // (a) discover it over RPC — the part a fire-and-forget tx can't hand back
    const pend = await (await fetch(h.rpcBase + "/live/v1/dev/oracle-pending")).json();
    expect(pend.queries.length).toBe(1);
    const q = pend.queries[0];
    expect(q.slot).toBe(SLOT);
    expect(BigInt(q.queryId)).toBeGreaterThan(0n);
    expect(Buffer.from(q.query, "base64").length).toBeGreaterThan(0); // the contract's OracleQuery bytes

    // (b) inject the reply -> fires the contract's OnReply notification
    const res = await post(h.rpcBase + "/live/v1/dev/oracle-resolve", { queryId: q.queryId, reply: Buffer.from(mockReply(21n, 42n)).toString("base64") });
    expect(res.ok).toBe(true);
    expect(i64(srv.engine.sim.query(SLOT, LAST, new Uint8Array(0)))).toBe(42n); // OnReply stored the doubledValue
    expect((await (await fetch(h.rpcBase + "/live/v1/dev/oracle-pending")).json()).queries.length).toBe(0); // no longer pending

    // unknown id -> false
    const bad = await post(h.rpcBase + "/live/v1/dev/oracle-resolve", { queryId: "999", reply: Buffer.from(mockReply(1n, 2n)).toString("base64") });
    expect(bad.ok).toBe(false);
  } finally {
    h.stop();
  }
}, 30_000);
