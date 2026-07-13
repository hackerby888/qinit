// TickConsensus (ticking.ts) in isolation — no Sim. A fake ConsensusHost supplies the three state digests, the
// tick's tx digests, and the clock/tick/epoch, so the committee + quorum-vote + TickData record logic runs
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex } from "../../src/k12";
import { TickConsensus, type ConsensusHost } from "../../src/ticking";

beforeAll(async () => {
  await initK12(); // committee key derivation + the vote/TickData signatures
});

const SEEDS = ["a".repeat(55), "b".repeat(55), "c".repeat(55), "d".repeat(55)]; // a 4-computor committee (quorum 3)

function fill(b: number): Uint8Array {
  return new Uint8Array(32).fill(b);
}

// A fake host with a settable clock/tick/epoch and fixed state digests.
function fakeHost(): ConsensusHost & { t: number; e: number } {
  const h = {
    t: 0,
    e: 0,
    spectrumDigest: () => fill(0x11),
    universeDigest: () => fill(0x22),
    computerDigest: () => fill(0x33),
    tickTransactionDigests: (_tick: number) => [fill(0xaa)],
    nowMs: () => 1700000000000 + h.t * 50,
    tick: () => h.t,
    epoch: () => h.e,
  };
  return h;
}

test("committee + quorum derive from the configured seeds", () => {
  const tc = new TickConsensus(fakeHost(), { computorSeeds: SEEDS });
  expect(tc.committeeSize()).toBe(4);
  expect(tc.getCommittee().computors.length).toBe(4);
  expect(tc.quorum()).toBe(3); // floor(4*2/3)+1
});

test("prev*Digest are zero until the first finalize, then the committed roots", () => {
  const h = fakeHost();
  const tc = new TickConsensus(h, { computorSeeds: SEEDS });
  expect(tc.prevSpectrumDigest().every((x) => x === 0)).toBe(true);

  h.t = 1;
  tc.finalizeTick();
  expect(toHex(tc.prevSpectrumDigest())).toBe("11".repeat(32));
  expect(toHex(tc.prevUniverseDigest())).toBe("22".repeat(32));
  expect(toHex(tc.prevComputerDigest())).toBe("33".repeat(32));
});

test("finalizeTick records the quorum votes + signed TickData for the tick", () => {
  const h = fakeHost();
  const tc = new TickConsensus(h, { computorSeeds: SEEDS });

  expect(tc.tickRecord(7)).toBeUndefined(); // not finalized yet
  expect(tc.alignedVotes(7)).toBe(0);
  expect(tc.tickData(7)).toBeUndefined();

  h.t = 7;
  tc.finalizeTick();

  const rec = tc.tickRecord(7)!;
  expect(rec).toBeDefined();
  expect(rec.votes.length).toBe(4); // one vote per computor
  expect(rec.total).toBe(4);
  expect(rec.aligned).toBeGreaterThanOrEqual(3); // an honest committee always reaches quorum
  expect(rec.aligned).toBe(tc.alignedVotes(7));
  expect(tc.tickData(7)).toBe(rec.tickData);
  expect(rec.tickData.bytes.length).toBe(139376); // TickData
  expect(toHex(rec.digests.spectrum)).toBe("11".repeat(32));
});

// A host whose tx-digest list is settable, to exercise empty vs non-empty ticks under lite ticking.
function fakeHostTx(): ConsensusHost & { t: number; e: number; txs: Uint8Array[] } {
  const h = {
    t: 0,
    e: 0,
    txs: [] as Uint8Array[],
    spectrumDigest: () => fill(0x11),
    universeDigest: () => fill(0x22),
    computerDigest: () => fill(0x33),
    tickTransactionDigests: (_tick: number) => h.txs,
    nowMs: () => 1700000000000 + h.t * 50,
    tick: () => h.t,
    epoch: () => h.e,
  };
  return h;
}

test("lite ticking: an EMPTY tick skips the quorum record but still advances the digest chain", () => {
  const h = fakeHostTx();
  const tc = new TickConsensus(h, { computorSeeds: SEEDS }, true); // lite = true

  h.t = 5;
  h.txs = []; // empty tick
  tc.finalizeTick();

  expect(tc.tickRecord(5)).toBeUndefined(); // no quorum record built (the costly FourQ votes are skipped)
  expect(tc.alignedVotes(5)).toBe(0);
  expect(tc.tickData(5)).toBeUndefined();
  expect(toHex(tc.prevSpectrumDigest())).toBe("11".repeat(32)); // digest chain still advanced
  expect(toHex(tc.prevComputerDigest())).toBe("33".repeat(32));
});

test("lite ticking: a tick WITH transactions still builds the full quorum record", () => {
  const h = fakeHostTx();
  const tc = new TickConsensus(h, { computorSeeds: SEEDS }, true); // lite = true

  h.t = 6;
  h.txs = [fill(0xaa)]; // non-empty tick
  tc.finalizeTick();

  const rec = tc.tickRecord(6)!;
  expect(rec).toBeDefined();
  expect(rec.votes.length).toBe(4); // full committee vote set, even in lite mode
  expect(rec.aligned).toBeGreaterThanOrEqual(3);
});

test("non-lite (default): an empty tick still builds the full quorum record", () => {
  const h = fakeHostTx();
  const tc = new TickConsensus(h, { computorSeeds: SEEDS }); // lite defaults off

  h.t = 8;
  h.txs = []; // empty tick — but node/CLI builds the record regardless
  tc.finalizeTick();

  expect(tc.tickRecord(8)).toBeDefined();
  expect(tc.tickRecord(8)!.votes.length).toBe(4);
});

test("signedComputorList is produced for the current epoch", () => {
  const h = fakeHost();
  h.e = 2;
  const tc = new TickConsensus(h, { computorSeeds: SEEDS });
  const list = tc.signedComputorList(); // epoch(2) + publicKeys[size*32] + signature(64)
  expect(list.length).toBe(2 + 4 * 32 + 64);
});
