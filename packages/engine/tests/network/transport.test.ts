// Exercises NodeTransport through real codecs, signed transactions, and deploy wire data.
import { test, expect } from "bun:test";
import { buildSignedTx, k12Hex, deriveIdentity, identityToBytes } from "@qinit/core";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import {
  encodeInput,
  decodeOutput,
  contractAddress,
  encodeUploadBegin,
  encodeUploadChunk,
  encodeDeploy,
  chunkSo,
  newSessionId,
  LITE_TX,
} from "@qinit/proto";
import { VirtualNode } from "../../src/transport";

const SEED = "a".repeat(55);
const ORACLE = "4b31b54f2213f1396cec4a1bd633b9409112d5969592c2c5fa66ddc1656f63c9";

// Build an unsigned canonical transaction for deploy-wire tests with real header offsets.
function wrapTx(inputType: number, payload: Uint8Array, destU64: bigint): Uint8Array {
  const b = new Uint8Array(80 + payload.length + 64);
  const v = new DataView(b.buffer);
  v.setBigUint64(32, destU64, true); // destination u64._0
  v.setUint32(72, 10, true); // tick
  v.setUint16(76, inputType, true);
  v.setUint16(78, payload.length, true);
  b.set(payload, 80);
  return b;
}

test("seam: qinit codec + a REAL signed tx drive the in-process engine (Counter)", async () => {
  const eng = await VirtualNode.create({ mempool: false }); // assert apply immediately (not mempool scheduling)
  eng.deploy(28, await wasm("Counter"), "Counter");

  // dynRegistry exposes the contract + its fn/proc inputTypes (what resolveSlot / the client read)
  const reg = await eng.dynRegistry();
  const c = reg.contracts.find((x) => x.index === 28)!;
  expect(c.armed && c.constructed).toBe(true);
  expect(c.name).toBe("Counter");
  expect(c.functions.map((f) => f.inputType)).toContain(1);
  expect(c.procedures.map((p) => p.inputType)).toContain(1);

  // Get (function) via querySmartContract + the real proto decode
  expect(
    await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64"),
  ).toBe(0n);

  // Inc (procedure) via a REAL @qubic-lib signed tx -> broadcastTx (validates the engine decodes the real wire)
  const tx = await buildSignedTx(SEED, {
    destination: contractAddress(28),
    amount: 0,
    tick: 10,
    inputType: 1,
    payload: await encodeInput(""),
  });
  expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);

  expect(
    await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64"),
  ).toBe(1n);
});

test("seam: deploy via the UPLOAD_BEGIN/CHUNK/DEPLOY wire protocol (DigestProbe -> oracle)", async () => {
  const eng = await VirtualNode.create({ mempool: false }); // assert apply immediately (not mempool scheduling)
  const so = await wasm("DigestProbe");
  const finalHashHex = await k12Hex(so);
  const sessionId = newSessionId();
  const chunks = chunkSo(so);

  await eng.broadcastTx(
    wrapTx(
      LITE_TX.UPLOAD_BEGIN,
      encodeUploadBegin({
        sessionId,
        totalSize: so.length,
        chunkCount: chunks.length,
        finalHashHex,
      }),
      99999n,
    ),
  );
  for (let i = 0; i < chunks.length; i++)
    await eng.broadcastTx(
      wrapTx(
        LITE_TX.UPLOAD_CHUNK,
        encodeUploadChunk({ sessionId, seq: i, bytes: chunks[i] }),
        99999n,
      ),
    );
  expect((await eng.dynUpload()).complete).toBe(true);

  await eng.broadcastTx(
    wrapTx(
      LITE_TX.DEPLOY,
      encodeDeploy({ sessionId, targetSlot: 29, finalHashHex, name: "DigestProbe" }),
      99999n,
    ),
  );
  const reg = await eng.dynRegistry();
  expect(reg.contracts.find((x) => x.index === 29)?.constructed).toBe(true);
  expect(reg.contracts.find((x) => x.index === 29)?.name).toBe("DigestProbe");

  // Exercise the wire-deployed contract + reproduce the cross-platform digest oracle through the seam.
  expect(
    await decodeOutput(await eng.querySmartContract(29, 1, await encodeInput("")), "uint64"),
  ).toBe(0n);
  await eng.broadcastTx(wrapTx(1, new Uint8Array(0), 29n)); // Inc (procedure it=1)
  expect(
    await decodeOutput(await eng.querySmartContract(29, 1, await encodeInput("")), "uint64"),
  ).toBe(1n);
  expect(eng.sim.digest(29)).toBe(ORACLE);
});

test("UPLOAD_BEGIN keeps the active session across retries and rejects a different session", async () => {
  const eng = await VirtualNode.create({ mempool: false });
  const first = 11n;
  const begin = (sessionId: bigint, totalSize: number, chunkCount: number, hash: string) =>
    (eng as any).handleDeployTx(
      LITE_TX.UPLOAD_BEGIN,
      encodeUploadBegin({ sessionId, totalSize, chunkCount, finalHashHex: hash }),
    );

  begin(first, 8, 2, "11".repeat(32));
  (eng as any).handleDeployTx(
    LITE_TX.UPLOAD_CHUNK,
    encodeUploadChunk({ sessionId: first, seq: 0, bytes: new Uint8Array([1, 2, 3]) }),
  );
  const active = (eng as any).upload;
  const buffer = [...active.buf];

  expect(() => begin(first, 4, 1, "22".repeat(32))).not.toThrow();
  expect((eng as any).upload).toBe(active);
  expect(await eng.dynUpload()).toMatchObject({
    sessionId: "11",
    totalSize: 8,
    chunkCount: 2,
    receivedCount: 1,
    finalHash: "11".repeat(32),
  });
  expect([...(eng as any).upload.buf]).toEqual(buffer);

  expect(() => begin(22n, 4, 1, "22".repeat(32))).toThrow(
    "another contract upload is active (session 11, 1/2 chunks); wait for it to complete",
  );
  expect((eng as any).upload).toBe(active);
  expect([...(eng as any).upload.buf]).toEqual(buffer);
  expect((await eng.dynUpload()).receivedCount).toBe(1);
});

test("signature verification (opt-in): valid signed tx accepted, tampered one rejected", async () => {
  const eng = await VirtualNode.create({ verifySigs: true, mempool: false }); // assert apply immediately
  eng.deploy(28, await wasm("Counter"), "Counter");

  const tx = await buildSignedTx(SEED, {
    destination: contractAddress(28),
    amount: 0,
    tick: 10,
    inputType: 1,
    payload: await encodeInput(""),
  });
  expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);
  expect(
    await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64"),
  ).toBe(1n); // applied

  const bad = tx.bytes.slice();
  bad[bad.length - 1] ^= 0xff; // flip a signature byte
  const r = await eng.broadcastTx(bad);
  expect(r.ok).toBe(false);
  expect(r.message).toContain("invalid signature");
});

test("broadcastTx reports moneyFlew + queued for an applied transfer (the IDE reads r.moneyFlew)", async () => {
  const eng = await VirtualNode.create({ mempool: false, fees: "off" }); // applied now, no fee gate
  const dest = new Uint8Array(32).fill(0x55);

  eng.sim.fund(identityToBytes((await deriveIdentity(SEED)).identity), 1000n); // fund the sender
  const funded = await buildSignedTx(SEED, {
    destination: dest,
    amount: 100,
    tick: 10,
    inputType: 0,
    payload: new Uint8Array(0),
  });
  const r = await eng.broadcastTx(funded.bytes);
  expect(r.ok).toBe(true);
  expect(r.queued).toBe(false); // mempool:false -> the tx is applied at broadcast, not queued
  expect(r.moneyFlew).toBe(true); // the 100 qu actually moved

  const broke = await buildSignedTx("c".repeat(55), {
    destination: dest,
    amount: 100,
    tick: 10,
    inputType: 0,
    payload: new Uint8Array(0),
  });
  expect((await eng.broadcastTx(broke.bytes)).moneyFlew).toBe(false); // unfunded sender -> no money moved
});

test("VirtualNode re-exposes the direct engine ops (procedure/query/digests) matching sim", async () => {
  const eng = await VirtualNode.create({ fees: "off" });
  eng.deploy(28, await wasm("Counter"), "Counter");

  expect(await decodeOutput(eng.query(28, 1), "uint64")).toBe(0n); // direct query (instant, no tx)
  eng.procedure(28, 1); // direct Inc (instant, no signing)
  expect(await decodeOutput(eng.query(28, 1), "uint64")).toBe(1n);

  // they delegate to the same engine -> byte-identical to reaching into eng.sim
  expect(eng.query(28, 1)).toEqual(eng.sim.query(28, 1));
  expect(eng.computerDigest()).toEqual(eng.sim.computerDigest());
  expect(eng.spectrumDigest()).toEqual(eng.sim.spectrumDigest());
  expect(eng.universeDigest()).toEqual(eng.sim.universeDigest());
});

test("fund + balance accept either an id string or raw bytes (unified id type)", async () => {
  const eng = await VirtualNode.create({ fees: "off" });
  const idStr = (await deriveIdentity(SEED)).identity;
  const idBytes = identityToBytes(idStr);

  eng.fund(idBytes, 500n); // fund by bytes
  expect((await eng.balance(idStr)).balance).toBe("500"); // read by string

  eng.fund(idStr, 250n); // fund by string (adds)
  const b = await eng.balance(idBytes); // read by bytes
  expect(b.balance).toBe("750");
  expect(b.id).toBe(idStr); // bytes input -> canonical identity in the response
});

test("engine emits a diagnostic log stream (deploy/tick/tx events via onLog)", async () => {
  const eng = await VirtualNode.create({ mempool: false, fees: "off" });
  const ev: { level: string; cat: string; msg: string }[] = [];
  eng.onLog = (e) => ev.push(e);

  eng.deploy(28, await wasm("Counter"), "Counter");
  expect(ev.some((e) => e.cat === "deploy" && e.level === "info")).toBe(true);

  eng.advanceTick(1);
  expect(ev.some((e) => e.cat === "tick" && e.level === "debug" && /begin/.test(e.msg))).toBe(true);
  expect(ev.some((e) => e.cat === "tick" && /end/.test(e.msg))).toBe(true);

  ev.length = 0;
  const tx = await buildSignedTx(SEED, {
    destination: contractAddress(28),
    amount: 0,
    tick: 10,
    inputType: 1,
    payload: await encodeInput(""),
  });
  await eng.broadcastTx(tx.bytes);
  expect(ev.some((e) => e.cat === "tx" && e.level === "info")).toBe(true);

  // Unset = no-op: a fresh node with no subscriber doesn't throw.
  const quiet = await VirtualNode.create({ mempool: false, fees: "off" });
  quiet.deploy(28, await wasm("Counter"), "Counter");
  quiet.advanceTick(1);
  expect(true).toBe(true);
});
