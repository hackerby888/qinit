// Phase 2 — the NodeTransport seam. Proves the in-process engine answers qinit's RPC surface and is driven by
// qinit's OWN codec (encodeInput/decodeOutput), a REAL @qubic-lib signed tx, and the real deploy wire
// protocol — i.e. it is interchangeable with the HTTP LiteRpc backend.
import { test, expect } from "bun:test";
import { buildSignedTx, k12Hex } from "@qinit/core";
import {
  encodeInput, decodeOutput, contractAddress,
  encodeUploadBegin, encodeUploadChunk, encodeDeploy, chunkSo, newSessionId, LITE_TX,
} from "@qinit/proto";
import { initK12 } from "../src/k12";
import { InProcessEngine } from "../src/transport";

const FIX = import.meta.dir + "/fixtures";
const SEED = "a".repeat(55);
const ORACLE = "4b31b54f2213f1396cec4a1bd633b9409112d5969592c2c5fa66ddc1656f63c9";
async function wasm(n: string): Promise<Uint8Array> { return new Uint8Array(await Bun.file(`${FIX}/${n}.wasm`).arrayBuffer()); }

// A tx with the canonical Qubic header but no real signature — the engine ignores it (consensus simplified).
// Lets the deploy wire path run without a FourQ sign per chunk. The header offsets are validated against real
// @qubic-lib output by the "REAL signed tx" assertion below.
function wrapTx(inputType: number, payload: Uint8Array, destU64: bigint): Uint8Array {
  const b = new Uint8Array(80 + payload.length + 64);
  const v = new DataView(b.buffer);
  v.setBigUint64(32, destU64, true); // destination u64._0
  v.setUint32(72, 10, true);         // tick
  v.setUint16(76, inputType, true);
  v.setUint16(78, payload.length, true);
  b.set(payload, 80);
  return b;
}

test("seam: qinit codec + a REAL signed tx drive the in-process engine (Counter)", async () => {
  await initK12();
  const eng = new InProcessEngine();
  eng.deploy(28, await wasm("Counter"), "Counter");

  // dynRegistry exposes the contract + its fn/proc inputTypes (what resolveSlot / the client read)
  const reg = await eng.dynRegistry();
  const c = reg.contracts.find((x) => x.index === 28)!;
  expect(c.armed && c.constructed).toBe(true);
  expect(c.name).toBe("Counter");
  expect(c.functions.map((f) => f.inputType)).toContain(1);
  expect(c.procedures.map((p) => p.inputType)).toContain(1);

  // Get (function) via querySmartContract + the real proto decode
  expect(await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64")).toBe(0n);

  // Inc (procedure) via a REAL @qubic-lib signed tx -> broadcastTx (validates the engine decodes the real wire)
  const tx = await buildSignedTx(SEED, { destination: contractAddress(28), amount: 0, tick: 10, inputType: 1, payload: await encodeInput("") });
  expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);

  expect(await decodeOutput(await eng.querySmartContract(28, 1, await encodeInput("")), "uint64")).toBe(1n);
});

test("seam: deploy via the UPLOAD_BEGIN/CHUNK/DEPLOY wire protocol (DigestProbe -> oracle)", async () => {
  await initK12();
  const eng = new InProcessEngine();
  const so = await wasm("DigestProbe");
  const finalHashHex = await k12Hex(so);
  const sessionId = newSessionId();
  const chunks = chunkSo(so);

  await eng.broadcastTx(wrapTx(LITE_TX.UPLOAD_BEGIN, encodeUploadBegin({ sessionId, totalSize: so.length, chunkCount: chunks.length, finalHashHex }), 99999n));
  for (let i = 0; i < chunks.length; i++)
    await eng.broadcastTx(wrapTx(LITE_TX.UPLOAD_CHUNK, encodeUploadChunk({ sessionId, seq: i, bytes: chunks[i] }), 99999n));
  expect((await eng.dynUpload()).complete).toBe(true);

  await eng.broadcastTx(wrapTx(LITE_TX.DEPLOY, encodeDeploy({ sessionId, targetSlot: 29, finalHashHex, name: "DigestProbe" }), 99999n));
  const reg = await eng.dynRegistry();
  expect(reg.contracts.find((x) => x.index === 29)?.constructed).toBe(true);
  expect(reg.contracts.find((x) => x.index === 29)?.name).toBe("DigestProbe");

  // Exercise the wire-deployed contract + reproduce the cross-platform digest oracle through the seam.
  expect(await decodeOutput(await eng.querySmartContract(29, 1, await encodeInput("")), "uint64")).toBe(0n);
  await eng.broadcastTx(wrapTx(1, new Uint8Array(0), 29n)); // Inc (procedure it=1)
  expect(await decodeOutput(await eng.querySmartContract(29, 1, await encodeInput("")), "uint64")).toBe(1n);
  expect(eng.sim.digest(29)).toBe(ORACLE);
});
