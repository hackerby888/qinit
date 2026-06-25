// Tick consensus — core-lite's quorum model ported to the deterministic in-process sim. One process plays all
// N honest computors: each tick, every computor computes the same chain-state digests, signs a Tick vote, and
// the tick finalizes once aligned votes >= QUORUM (always, for an honest committee). Grounded in core-lite
// src/network_messages/{tick.h, computors.h, common_def.h} + the qubic.cpp tick processor. All crypto is the
// sync FourQ/K12 from @qinit/core (deriveKeysSync / signSync), so Sim.advance() stays synchronous.
import { k12Bytes, deriveKeysSync, signSync, verifySync, type KeyPair } from "./k12";
import { dateFields } from "./runtime";
import { rootFromSiblings } from "./merkle";
import { M256i, Tick, TickData, DIGEST_SIZE, SIG_SIZE, TXS_PER_TICK, TICKDATA_SIZE } from "./wire";

export { TXS_PER_TICK, TICKDATA_SIZE };
export const DEFAULT_ARBITRATOR_SEED = "a".repeat(55); // arbitrator identity = derive("aaa…a")
export const DEFAULT_NUMBER_OF_COMPUTORS = 8; // core-lite LITE testnet committee (common_def.h)
export const MAX_NUMBER_OF_CONTRACTS = 1024; // common_def.h — computer-digest merkle leaf count
export const TICK_SIZE = Tick.SIZE; // network_messages/tick.h (352), including the 64-byte signature
const TICK_TYPE = 3; // BROADCAST_TICK — XORed into computorIndex for vote-signature domain separation (qubic.cpp)
const SEED_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

// QUORUM = floor(N*2/3)+1 (core-lite common_def.h:17).
export function quorumOf(n: number): number {
  return Math.floor((n * 2) / 3) + 1;
}

// A fresh random 55-letter Qubic seed (the default per-computor identity source).
export function randomSeed(): string {
  let s = "";
  for (let i = 0; i < 55; i++) {
    s += SEED_ALPHABET[Math.floor(Math.random() * 26)];
  }
  return s;
}

export interface Computor extends KeyPair {
  index: number;
  seed: string;
}

export interface CommitteeOpts {
  numberOfComputors?: number; // default 8 (ignored when computorSeeds is given)
  computorSeeds?: string[]; // explicit seeds (reproducible); else N random seeds
  arbitratorSeed?: string; // default "a".repeat(55)
}

// The committee that signs ticks + the arbitrator that signs the committee list. Derives every key
// synchronously (deriveKeysSync), so it must be constructed after initK12().
export class Committee {
  readonly computors: Computor[];
  readonly arbitrator: KeyPair & { seed: string };
  readonly quorum: number;

  constructor(opts: CommitteeOpts = {}) {
    const n = opts.numberOfComputors ?? DEFAULT_NUMBER_OF_COMPUTORS;
    const seeds = opts.computorSeeds ?? Array.from({ length: n }, () => randomSeed());

    this.computors = seeds.map((seed, index) => ({ index, seed, ...deriveKeysSync(seed) }));
    const arbSeed = opts.arbitratorSeed ?? DEFAULT_ARBITRATOR_SEED;
    this.arbitrator = { seed: arbSeed, ...deriveKeysSync(arbSeed) };
    this.quorum = quorumOf(this.computors.length);
  }

  get size(): number {
    return this.computors.length;
  }

  // The signed Computors wire struct (core-lite computors.h): epoch(2) + publicKeys[slotCount*32] +
  // arbitrator signature(64) over K12(struct − signature). slotCount defaults to the committee size; the
  // peer-protocol bridge pads to the protocol's 676-slot list (the real NUMBER_OF_COMPUTORS).
  signedComputorList(epoch: number, slotCount = this.computors.length): Uint8Array {
    const size = 2 + slotCount * DIGEST_SIZE + SIG_SIZE;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    dv.setUint16(0, epoch & 0xffff, true);

    for (const c of this.computors) {
      if (c.index < slotCount) {
        buf.set(c.publicKey, 2 + c.index * DIGEST_SIZE);
      }
    }

    const digest = k12Bytes(buf.subarray(0, size - SIG_SIZE));
    buf.set(signSync(this.arbitrator.privateKey, this.arbitrator.publicKey, digest), size - SIG_SIZE);
    return buf;
  }
}

// The chain-state digests a tick vote commits to. spectrum/universe are the roots of the incremental 2^24
// SparseMerkle trees (SpectrumLedger.getSpectrumDigest / AssetLedger.getUniverseDigest); computer is the
// 1024-leaf contract-state merkle; transaction is K12 of the leader's signed TickData. A light client recomputes
// spectrum/universe/computer from a merkle proof and checks it against these committed roots (verifyEntityProof
// + the digest-chain test pin that the proof root equals the digest a quorum of votes signed).
export interface TickStateDigests {
  spectrum: Uint8Array;
  universe: Uint8Array;
  computer: Uint8Array;
  transaction: Uint8Array;
  expectedNextTransaction: Uint8Array;
}

// Binary merkle root via K12 over `capacity` (a power of two) leaves; absent leaves are zero, parent =
// K12(left32 ‖ right32). Mirrors core-lite getComputerDigest over MAX_NUMBER_OF_CONTRACTS contract-state leaves.
export function merkleRoot(leaves: Map<number, Uint8Array>, capacity: number): Uint8Array {
  let level: Uint8Array[] = [];
  for (let i = 0; i < capacity; i++) {
    level.push(leaves.get(i) ?? new Uint8Array(DIGEST_SIZE));
  }

  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const pair = new Uint8Array(2 * DIGEST_SIZE);
      pair.set(level[i], 0);
      pair.set(level[i + 1], DIGEST_SIZE);
      next.push(k12Bytes(pair));
    }
    level = next;
  }

  return level[0];
}

// salted digest = K12(publicKey(32) ‖ prevDigest(32)) — the per-computor salt (qubic.cpp:5707).
function saltedDigest(publicKey: Uint8Array, prev: Uint8Array): Uint8Array {
  const buf = new Uint8Array(2 * DIGEST_SIZE);
  buf.set(publicKey.subarray(0, DIGEST_SIZE), 0);
  buf.set(prev.subarray(0, DIGEST_SIZE), DIGEST_SIZE);
  return k12Bytes(buf);
}

// Build + sign one computor's 352-byte Tick vote (network_messages/tick.h). The three m256i state digests are
// committed as prev*Digest and as salted*Digest = K12(pubKey ‖ prevDigest). Time fields and the u32
// resource/tx-body digests are zeroed (deterministic; not modeled in the dev sim). The signature is FourQ over
// K12(Tick − signature), with the mainnet TARGET_TICK_VOTE_SIGNATURE proof-of-work intentionally skipped.
export function buildTickVote(c: Computor, epoch: number, tick: number, d: TickStateDigests, timeMs: number): Tick {
  const v = Tick.alloc();
  v.computorIndex = c.index;
  v.epoch = epoch;
  v.tick = tick;

  // timestamp; the resource-testing / tx-body u32 digests stay zero (deterministic, not modeled in the dev sim).
  const t = dateFields(timeMs);
  v.millisecond = t.milli;
  v.second = t.second;
  v.minute = t.minute;
  v.hour = t.hour;
  v.day = t.day;
  v.month = t.month;
  v.year = t.year;

  v.prevSpectrumDigest = M256i.from(d.spectrum);
  v.prevUniverseDigest = M256i.from(d.universe);
  v.prevComputerDigest = M256i.from(d.computer);
  v.saltedSpectrumDigest = M256i.from(saltedDigest(c.publicKey, d.spectrum));
  v.saltedUniverseDigest = M256i.from(saltedDigest(c.publicKey, d.universe));
  v.saltedComputerDigest = M256i.from(saltedDigest(c.publicKey, d.computer));
  v.transactionDigest = M256i.from(d.transaction);
  v.expectedNextTickTransactionDigest = M256i.from(d.expectedNextTransaction);

  // Domain-separate the signed message by XORing computorIndex with the Tick message type (qubic.cpp does the
  // same XOR before verifying). The transmitted struct keeps the plain index.
  v.computorIndex = (c.index ^ TICK_TYPE) & 0xffff;
  const digest = k12Bytes(v.bytes.subarray(0, TICK_SIZE - SIG_SIZE));
  v.computorIndex = c.index;
  v.signature = signSync(c.privateKey, c.publicKey, digest);
  return v;
}

// The K12 message a tick vote's signature covers: the Tick − signature, with computorIndex XORed by the Tick
// message type (the qubic domain-separation tweak). For verification in tests / the bridge.
export function tickVoteMessage(vote: Uint8Array): Uint8Array {
  const body = vote.slice(0, TICK_SIZE - SIG_SIZE);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, (dv.getUint16(0, true) ^ TICK_TYPE) & 0xffff, true);
  return k12Bytes(body);
}

export function tickVoteSignature(vote: Uint8Array): Uint8Array {
  return vote.subarray(TICK_SIZE - SIG_SIZE, TICK_SIZE);
}

// ---- TickData (network_messages/tick.h; BROADCAST_FUTURE_TICK_DATA) ----
// The leader-proposed transaction set for a tick, in the wire form an external Qubic client reads:
// computorIndex(2) epoch(2) tick(4) [millisecond(2) second minute hour day month year(1 each)] timelock(32)
// transactionDigests[NUMBER_OF_TRANSACTIONS_PER_TICK][32] contractFees[…](8 each) signature(64). The leader is
// computor[tick % N]; the signature is FourQ over K12(TickData − signature) with computorIndex XORed by the
// future-tick-data message type (the same domain-separation tweak qubic.cpp applies before verifying).
const TICKDATA_TYPE = 8; // BROADCAST_FUTURE_TICK_DATA — XORed into computorIndex for the signature domain

// timelock = K12(spectrumDigest ‖ universeDigest ‖ computerDigest) — the tick's committed state roots.
function tickDataTimelock(spectrum: Uint8Array, universe: Uint8Array, computer: Uint8Array): Uint8Array {
  const buf = new Uint8Array(3 * DIGEST_SIZE);
  buf.set(spectrum.subarray(0, DIGEST_SIZE), 0);
  buf.set(universe.subarray(0, DIGEST_SIZE), DIGEST_SIZE);
  buf.set(computer.subarray(0, DIGEST_SIZE), 2 * DIGEST_SIZE);
  return k12Bytes(buf);
}

// Build + sign the tick's TickData. The leader (computor[tick % N]) commits the tick's per-tx digests (each =
// K12(full signed tx), in order, zero-padded to the capacity) and the state roots; contractFees stay zero.
export function buildTickData(committee: Committee, epoch: number, tick: number, txDigests: Uint8Array[], roots: { spectrum: Uint8Array; universe: Uint8Array; computer: Uint8Array }, timeMs: number): TickData {
  const leaderIndex = tick % committee.size;
  const leader = committee.computors[leaderIndex];

  const td = TickData.alloc();
  td.computorIndex = leaderIndex;
  td.epoch = epoch;
  td.tick = tick;

  const t = dateFields(timeMs);
  td.millisecond = t.milli;
  td.second = t.second;
  td.minute = t.minute;
  td.hour = t.hour;
  td.day = t.day;
  td.month = t.month;
  td.year = t.year;

  td.timelock = M256i.from(tickDataTimelock(roots.spectrum, roots.universe, roots.computer));

  const count = Math.min(txDigests.length, TXS_PER_TICK);
  for (let i = 0; i < count; i++) {
    td.txDigests.set(i, txDigests[i]);
  }

  // Domain-separate the signed message (XOR the index by the message type); the transmitted struct keeps the
  // plain index. The signature is stored — the votes commit K12(the whole signed TickData).
  td.computorIndex = (leaderIndex ^ TICKDATA_TYPE) & 0xffff;
  const digest = k12Bytes(td.bytes.subarray(0, TickData.SIG_OFFSET));
  td.computorIndex = leaderIndex;
  td.signature = signSync(leader.privateKey, leader.publicKey, digest);

  return td;
}

export function tickDataSignature(td: Uint8Array): Uint8Array {
  return TickData.wrap(td).signature;
}

// The K12 message a TickData signature covers: the struct − signature, with computorIndex XORed by the
// future-tick-data type. For signature verification in tests / the bridge.
export function tickDataMessage(td: Uint8Array): Uint8Array {
  const body = td.slice(0, TickData.SIG_OFFSET);
  const dv = new DataView(body.buffer);
  dv.setUint16(0, (dv.getUint16(0, true) ^ TICKDATA_TYPE) & 0xffff, true);
  return k12Bytes(body);
}

// Does a vote commit to the etalon (canonical) state digests? The aligned-vote count for quorum.
export function voteIsAligned(vote: Tick, d: TickStateDigests): boolean {
  return vote.prevSpectrumDigest.equals(d.spectrum)
    && vote.prevUniverseDigest.equals(d.universe)
    && vote.prevComputerDigest.equals(d.computer)
    && vote.transactionDigest.equals(d.transaction);
}

// A light-client check: is `record` (an EntityRecord) provably part of the state that >= QUORUM computors
// signed? Recompute the spectrum root from the merkle proof, then count the tick votes that (a) carry a valid
// signature from their computor and (b) commit that exact spectrum root. True iff the count reaches quorum —
// i.e. the balance is in a state a supermajority of the committee agreed on, verified by math, not trust.
export function verifyEntityProof(record: Uint8Array, index: number, siblings: Uint8Array[], votes: Tick[], committee: Committee): boolean {
  if (index < 0) {
    return false;
  }

  const proofRoot = rootFromSiblings(record, index, siblings);

  let valid = 0;
  for (const vote of votes) {
    const c = committee.computors[vote.computorIndex];
    if (!c) {
      continue;
    }
    if (!verifySync(c.publicKey, tickVoteMessage(vote.bytes), tickVoteSignature(vote.bytes))) {
      continue;
    }
    if (!vote.prevSpectrumDigest.equals(proofRoot)) {
      continue;
    }
    valid++;
  }

  return valid >= committee.quorum;
}
