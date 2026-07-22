// Verifies entity Merkle proofs against spectrum roots signed by a computor quorum.
import { test, expect } from "bun:test";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";
import { verifyEntityProof } from "../../src/consensus";

const SEEDS4 = ["b".repeat(55), "c".repeat(55), "d".repeat(55), "e".repeat(55)];
const A = new Uint8Array(32).fill(0x33);
const B = new Uint8Array(32).fill(0x44);

async function fundedTick(): Promise<Sim> {
  await initK12();
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  sim.fund(A, 5000n);
  sim.fund(B, 100n); // a second entity so A's path carries real siblings
  sim.advance(); // finalize: the votes commit the spectrum digest including these balances
  return sim;
}

test("an entity proof verifies against the quorum-signed spectrum root", async () => {
  const sim = await fundedTick();
  const rec = sim.tickRecord(sim.tickN)!;
  const proof = sim.spectrumProof(A);

  // the balance is provably part of the state a supermajority of the committee signed
  expect(
    verifyEntityProof(proof.record, proof.index, proof.siblings, rec.votes, sim.getCommittee()),
  ).toBe(true);
});

test("a tampered balance record fails light-client verification", async () => {
  const sim = await fundedTick();
  const rec = sim.tickRecord(sim.tickN)!;
  const proof = sim.spectrumProof(A);

  const forged = proof.record.slice();
  new DataView(forged.buffer).setBigInt64(32, 999999n, true); // claim a bigger incomingAmount
  expect(
    verifyEntityProof(forged, proof.index, proof.siblings, rec.votes, sim.getCommittee()),
  ).toBe(false);
});

test("another entity's index + siblings fail (the proof is bound to the leaf)", async () => {
  const sim = await fundedTick();
  const rec = sim.tickRecord(sim.tickN)!;
  const pa = sim.spectrumProof(A);
  const pb = sim.spectrumProof(B);

  // A's record under B's path recomputes a different root that no signed vote commits to
  expect(verifyEntityProof(pa.record, pb.index, pb.siblings, rec.votes, sim.getCommittee())).toBe(
    false,
  );
});
