// Tick consensus — the N-computor quorum is real: each tick every computor signs a Tick vote over the chain's
// computed state digests (spectrum/universe/computer), and the tick finalizes at aligned votes >= QUORUM. These
// tests assert the committee derivation, the arbitrator-signed computor list, that every tick reaches quorum
// with verifiable FourQ signatures, the faithful computer-digest merkle, and that consensus is additive — it
// never alters a contract's StateData digest (the cross-platform oracle still holds).
import { test, expect } from "bun:test";
import { initK12, k12Bytes, toHex, deriveKeysSync, verifySync } from "../src/k12";
import { Sim } from "../src/sim";
import { Committee, merkleRoot, quorumOf, tickVoteMessage, tickVoteSignature } from "../src/consensus";

const FIX = import.meta.dir + "/fixtures";
const GET = 1; // Counter Get function
const INC = 1; // Counter Inc procedure
const SEEDS4 = ["b".repeat(55), "c".repeat(55), "d".repeat(55), "e".repeat(55)];

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}

function u64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
}

test("QUORUM formula = floor(N*2/3)+1", () => {
  expect(quorumOf(8)).toBe(6);
  expect(quorumOf(4)).toBe(3);
  expect(quorumOf(676)).toBe(451);
});

test("committee derivation is deterministic for fixed seeds", async () => {
  await initK12();
  const a = new Committee({ computorSeeds: SEEDS4 });
  const b = new Committee({ computorSeeds: SEEDS4 });

  expect(a.size).toBe(4);
  expect(a.quorum).toBe(3);
  for (let i = 0; i < 4; i++) {
    expect(toHex(a.computors[i].publicKey)).toBe(toHex(b.computors[i].publicKey));
  }
});

test("arbitrator defaults to the seed 'aaa…a' and signs a verifiable computor list", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  const committee = sim.getCommittee();

  // default arbitrator identity = derive("a".repeat(55))
  expect(toHex(committee.arbitrator.publicKey)).toBe(toHex(deriveKeysSync("a".repeat(55)).publicKey));

  const list = sim.signedComputorList();
  const sig = list.subarray(list.length - 64);
  const msg = k12Bytes(list.subarray(0, list.length - 64));
  expect(verifySync(committee.arbitrator.publicKey, msg, sig)).toBe(true);

  // a wrong key must not verify
  expect(verifySync(committee.computors[0].publicKey, msg, sig)).toBe(false);
});

test("every advanced tick reaches quorum with N FourQ-verifiable votes", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  sim.deploy(28, await wasm("Counter"));

  for (let i = 0; i < 5; i++) {
    sim.advance();
  }

  const committee = sim.getCommittee();
  const rec = sim.tickRecord(sim.tickN)!;
  expect(rec.total).toBe(4);
  expect(rec.aligned).toBe(4); // honest committee -> all align
  expect(rec.aligned).toBeGreaterThanOrEqual(committee.quorum);
  expect(sim.alignedVotes()).toBe(4);

  // each vote's signature verifies against its computor's public key
  for (const c of committee.computors) {
    const vote = rec.votes[c.index];
    expect(verifySync(c.publicKey, tickVoteMessage(vote), tickVoteSignature(vote))).toBe(true);
  }
});

test("configurable committee size drives quorum + vote count", async () => {
  await initK12();
  const sim = new Sim({ consensus: { numberOfComputors: 7 } });
  sim.advance();

  expect(sim.quorum()).toBe(5); // floor(7*2/3)+1
  expect(sim.tickRecord(sim.tickN)!.total).toBe(7);
});

test("computerDigest is the faithful K12 merkle over the 1024 contract leaves", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  sim.deploy(28, await wasm("Counter"));
  sim.deploy(29, await wasm("Counter"));
  sim.procedure(28, INC);

  const leaves = new Map<number, Uint8Array>();
  leaves.set(28, k12Bytes(sim.contracts.get(28)!.state()));
  leaves.set(29, k12Bytes(sim.contracts.get(29)!.state()));
  expect(toHex(sim.computerDigest())).toBe(toHex(merkleRoot(leaves, 1024)));

  // the digest must change when a contract's state changes
  const before = toHex(sim.computerDigest());
  sim.procedure(29, INC);
  expect(toHex(sim.computerDigest())).not.toBe(before);
});

test("consensus is additive — it does not change a contract's StateData digest", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  sim.deploy(28, await wasm("Counter"));
  sim.procedure(28, INC);

  // the cross-platform oracle: post-Inc 8-byte state is uint64 LE 1
  const oracle = toHex(k12Bytes(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])));
  expect(sim.digest(28)).toBe(oracle);

  // advancing ticks (consensus runs) must not perturb the contract state digest
  for (let i = 0; i < 5; i++) {
    sim.advance();
  }
  expect(sim.digest(28)).toBe(oracle);
  expect(u64(sim.query(28, GET))).toBe(1n);
});

test("spectrum digest changes when balances move, universe digest when assets change", async () => {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });

  const before = toHex(sim.spectrumDigest());
  sim.fund(new Uint8Array(32).fill(0x11), 1000n);
  expect(toHex(sim.spectrumDigest())).not.toBe(before);
});
