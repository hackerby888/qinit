// The digest chain — proof that the three committed state roots a tick vote carries (prevSpectrumDigest,
// prevUniverseDigest, prevComputerDigest) are the same roots a light client reconstructs from a merkle proof, and
// that a QUORUM of signed votes commits each. light-client.test.ts already pins the spectrum side via
// verifyEntityProof; this adds the missing asset (universe) analogue and the computer root, and asserts the
// byte-equality spectrum digest == proof root == every aligned vote's committed digest. Sources: consensus.ts
// (TickStateDigests / buildTickVote) + merkle.ts (rootFromSiblings) + core-lite network_messages/tick.h.
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex, verifySync } from "../src/k12";
import { Sim } from "../src/sim";
import { rootFromSiblings } from "../src/merkle";
import { tickVoteMessage, tickVoteSignature } from "../src/consensus";
import { Tick, M256i } from "../src/wire";
import { contractId } from "./helpers";

const SEEDS4 = ["b".repeat(55), "c".repeat(55), "d".repeat(55), "e".repeat(55)];
const A = new Uint8Array(32).fill(0x33);
const B = new Uint8Array(32).fill(0x44);

beforeAll(async () => {
  await initK12();
});

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}.wasm`).arrayBuffer());
}

// Count the votes that (a) carry a valid signature from their computor and (b) commit `expected` at the named
// prev*Digest field — the generalized form of verifyEntityProof's spectrum check, for any of the three roots.
function signedVotesCommitting(votes: Tick[], committee: ReturnType<Sim["getCommittee"]>, field: "prevSpectrumDigest" | "prevUniverseDigest" | "prevComputerDigest", expected: Uint8Array): number {
  let n = 0;
  for (const vote of votes) {
    const c = committee.computors[vote.computorIndex];
    if (!c) {
      continue;
    }
    if (!verifySync(c.publicKey, tickVoteMessage(vote.bytes), tickVoteSignature(vote.bytes))) {
      continue;
    }
    if ((vote[field] as M256i).equals(expected)) {
      n++;
    }
  }
  return n;
}

// A tick that mutates all three sub-states: fund two entities (spectrum), issue an asset (universe), deploy a
// contract (computer), then finalize so the votes commit the post-mutation roots.
async function loadedTick(): Promise<Sim> {
  const sim = new Sim({ consensus: { computorSeeds: SEEDS4 } });
  sim.fund(A, 5000n);
  sim.fund(B, 100n); // a second entity so A's spectrum path carries real siblings

  sim.deploy(28, await wasm("Token"));
  const issue = new Uint8Array(16);
  new DataView(issue.buffer).setBigUint64(0, 0x4e454b4f54n, true); // "TOKEN" packed LE
  new DataView(issue.buffer).setBigInt64(8, 1000n, true);
  sim.procedure(28, 1, issue); // id(28) issues + owns 1000 shares

  sim.advance(); // finalize: the votes commit the spectrum + universe + computer roots
  return sim;
}

test("the spectrum root: proof reconstruction == spectrumDigest == a quorum of signed votes", async () => {
  const sim = await loadedTick();
  const committee = sim.getCommittee();
  const rec = sim.tickRecord(sim.tickN)!;

  const proof = sim.spectrumProof(A);
  const root = rootFromSiblings(proof.record, proof.index, proof.siblings);
  expect(toHex(root)).toBe(toHex(sim.spectrumDigest()));
  expect(signedVotesCommitting(rec.votes, committee, "prevSpectrumDigest", root)).toBeGreaterThanOrEqual(committee.quorum);
});

test("the universe root: an asset holding proof == universeDigest == a quorum of signed votes", async () => {
  const sim = await loadedTick();
  const committee = sim.getCommittee();
  const rec = sim.tickRecord(sim.tickN)!;

  const owned = sim.universeProofOwned(contractId(28));
  expect(owned.length).toBe(1);
  const proof = owned[0];
  const root = rootFromSiblings(proof.record, proof.index, proof.siblings);
  expect(toHex(root)).toBe(toHex(sim.universeDigest()));
  expect(signedVotesCommitting(rec.votes, committee, "prevUniverseDigest", root)).toBeGreaterThanOrEqual(committee.quorum);
});

test("the computer root: computerDigest is committed by a quorum of signed votes", async () => {
  const sim = await loadedTick();
  const committee = sim.getCommittee();
  const rec = sim.tickRecord(sim.tickN)!;

  const root = sim.computerDigest();
  expect(signedVotesCommitting(rec.votes, committee, "prevComputerDigest", root)).toBeGreaterThanOrEqual(committee.quorum);
});

test("a tampered asset record fails the universe digest chain (no votes commit the forged root)", async () => {
  const sim = await loadedTick();
  const committee = sim.getCommittee();
  const rec = sim.tickRecord(sim.tickN)!;

  const proof = sim.universeProofOwned(contractId(28))[0];
  const forged = proof.record.slice();
  forged[40] ^= 0xff; // corrupt a share-count byte
  const root = rootFromSiblings(forged, proof.index, proof.siblings);

  expect(toHex(root)).not.toBe(toHex(sim.universeDigest()));
  expect(signedVotesCommitting(rec.votes, committee, "prevUniverseDigest", root)).toBe(0);
});
