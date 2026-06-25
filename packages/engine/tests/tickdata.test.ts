// TickData consensus — each tick's leader (computor[tick % N]) packs the tick's per-tx digests into a signed
// TickData; the quorum votes commit transaction = K12(TickData), and the bridge serves that exact artifact.
// These tests assert the leader rotation, the wire layout (size + computorIndex/epoch/tick + the tx digests),
// the leader signature, the vote↔TickData binding, and that a tx targeting the next tick lands in that tick.
import { test, expect } from "bun:test";
import { initK12, k12Bytes, toHex, verifySync } from "../src/k12";
import { Sim } from "../src/sim";
import { TICKDATA_SIZE, TXS_PER_TICK, tickDataMessage, tickDataSignature } from "../src/consensus";

const SEEDS4 = ["b".repeat(55), "c".repeat(55), "d".repeat(55), "e".repeat(55)];
const DIGESTS_OFFSET = 48; // first transactionDigests slot in the TickData
const FEES_OFFSET = DIGESTS_OFFSET + TXS_PER_TICK * 32; // contractFees[1024] region (131120..139312)

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

test("leader rotates as computor[tick % N] and signs the tick's TickData", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  const committee = sim.getCommittee();

  for (let i = 0; i < 6; i++) {
    sim.advance();
    const tick = sim.tickN;
    const td = sim.tickData(tick)!.bytes;

    expect(td.length).toBe(TICKDATA_SIZE); // 41072 — the cli TickData layout
    expect(dv(td).getUint16(0, true)).toBe(tick % 4); // computorIndex = leader = tick % N
    expect(dv(td).getUint16(2, true)).toBe(sim.epochN);
    expect(dv(td).getUint32(4, true)).toBe(tick);

    // the leader's FourQ signature verifies against computors[tick % N]
    const leader = committee.computors[tick % 4];
    expect(verifySync(leader.publicKey, tickDataMessage(td), tickDataSignature(td))).toBe(true);
  }
});

test("the quorum votes commit transaction = K12(TickData)", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  sim.advance();

  const rec = sim.tickRecord(sim.tickN)!;
  expect(toHex(rec.digests.transaction)).toBe(toHex(k12Bytes(rec.tickData.bytes)));
  expect(rec.aligned).toBe(4); // honest committee -> all align on K12(TickData)
});

test("a tx targeting the next tick lands in that tick's TickData and is processed there", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 }, mempool: true });

  const A = new Uint8Array(32).fill(0x11);
  const B = new Uint8Array(32).fill(0x22);
  sim.fund(A, 1000n);

  const target = sim.tickN + 1; // no 2-ahead enforcement: the very next tick is allowed
  const digest = k12Bytes(new Uint8Array([1, 2, 3, 4]));
  sim.enqueueTx(target, A, B, 100n, 0, new Uint8Array(0), "tx-1", digest);

  expect(sim.balance(B)).toBe(0n); // still queued for `target`

  sim.advance();
  expect(sim.tickN).toBe(target);

  expect(sim.balance(B)).toBe(100n); // processed at `target`
  expect(sim.tickTransactions(target).some((r) => r.txId === "tx-1")).toBe(true);

  // its digest is the first transactionDigests entry of `target`'s TickData
  const td = sim.tickData(target)!.bytes;
  expect(toHex(td.subarray(DIGESTS_OFFSET, DIGESTS_OFFSET + 32))).toBe(toHex(digest));
});

test("an empty tick still produces a signed TickData with zero tx digests", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  sim.advance();

  const td = sim.tickData(sim.tickN)!.bytes;
  expect(td.length).toBe(TICKDATA_SIZE);
  expect(toHex(td.subarray(DIGESTS_OFFSET, DIGESTS_OFFSET + 32))).toBe(toHex(new Uint8Array(32)));

  const leader = sim.getCommittee().computors[sim.tickN % 4];
  expect(verifySync(leader.publicKey, tickDataMessage(td), tickDataSignature(td))).toBe(true);
});

test("tampering a transaction digest or the signature breaks leader verification", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 }, mempool: true });
  sim.fund(new Uint8Array(32).fill(0x11), 1000n);
  const target = sim.tickN + 1;
  sim.enqueueTx(target, new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22), 1n, 0, new Uint8Array(0), "tx-1", k12Bytes(new Uint8Array([9])));
  sim.advance();

  const leader = sim.getCommittee().computors[target % 4];
  const good = sim.tickData(target)!.bytes;
  expect(verifySync(leader.publicKey, tickDataMessage(good), tickDataSignature(good))).toBe(true);

  // flip a byte inside the committed transactionDigests -> the signed message no longer matches
  const tdDigest = good.slice();
  tdDigest[DIGESTS_OFFSET] ^= 0xff;
  expect(verifySync(leader.publicKey, tickDataMessage(tdDigest), tickDataSignature(tdDigest))).toBe(false);

  // flip a byte of the signature itself
  const tdSig = good.slice();
  tdSig[TICKDATA_SIZE - 1] ^= 0xff;
  expect(verifySync(leader.publicKey, tickDataMessage(tdSig), tickDataSignature(tdSig))).toBe(false);
});

test("TickData layout: timelock = K12(state roots), contractFees + padding digests are zero", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 }, mempool: true });
  sim.fund(new Uint8Array(32).fill(0x11), 1000n);
  const target = sim.tickN + 1;
  const digest = k12Bytes(new Uint8Array([1, 2, 3, 4]));
  sim.enqueueTx(target, new Uint8Array(32).fill(0x11), new Uint8Array(32).fill(0x22), 1n, 0, new Uint8Array(0), "tx-1", digest);
  sim.advance();

  const td = sim.tickData(target)!.bytes;

  // timelock @16..48 = K12(spectrumDigest ‖ universeDigest ‖ computerDigest) (no state change after finalize)
  const roots = new Uint8Array(96);
  roots.set(sim.spectrumDigest(), 0);
  roots.set(sim.universeDigest(), 32);
  roots.set(sim.computerDigest(), 64);
  expect(toHex(td.subarray(16, 48))).toBe(toHex(k12Bytes(roots)));

  // the one tx occupies slot 0; every later digest slot is zero
  expect(toHex(td.subarray(DIGESTS_OFFSET, DIGESTS_OFFSET + 32))).toBe(toHex(digest));
  expect(td.subarray(DIGESTS_OFFSET + 32, FEES_OFFSET).every((b) => b === 0)).toBe(true);

  // contractFees[1024] region is left zero
  expect(td.subarray(FEES_OFFSET, TICKDATA_SIZE - 64).every((b) => b === 0)).toBe(true);
});

test("old TickData is pruned past the history window, recent ticks retained", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: ["b".repeat(55)] } }); // 1 computor -> fast advance
  for (let i = 0; i < 2100; i++) {
    sim.advance();
  }

  expect(sim.tickData(1)).toBeUndefined(); // beyond the 2000-tick window
  expect(sim.tickRecord(1)).toBeUndefined();
  expect(sim.tickData(sim.tickN)).toBeDefined(); // the latest tick is kept
}, 30000); // crossing the 2000-tick window is inherently a few seconds — above bun's 5s default
