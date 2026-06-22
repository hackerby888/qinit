// Tick consensus — core-lite's quorum model ported to the deterministic in-process sim. One process plays all
// N honest computors: each tick, every computor computes the same chain-state digests, signs a Tick vote, and
// the tick finalizes once aligned votes >= QUORUM (always, for an honest committee). Grounded in core-lite
// src/network_messages/{tick.h, computors.h, common_def.h} + the qubic.cpp tick processor. All crypto is the
// sync FourQ/K12 from @qinit/core (deriveKeysSync / signSync), so Sim.advance() stays synchronous.
import { k12Bytes, deriveKeysSync, signSync, type KeyPair } from "./k12";

export const DEFAULT_ARBITRATOR_SEED = "a".repeat(55); // arbitrator identity = derive("aaa…a")
export const DEFAULT_NUMBER_OF_COMPUTORS = 8; // core-lite LITE testnet committee (common_def.h)
export const MAX_NUMBER_OF_CONTRACTS = 1024; // common_def.h — computer-digest merkle leaf count
export const TICK_SIZE = 352; // network_messages/tick.h, including the 64-byte signature
const TICK_TYPE = 3; // BROADCAST_TICK — XORed into computorIndex for vote-signature domain separation (qubic.cpp)
const SIG_SIZE = 64;
const DIGEST_SIZE = 32;
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

// The chain-state digests a tick vote commits to. spectrum/universe are testnet-canonical (K12 over the sorted
// occupied entries); computer is the faithful 1024-leaf merkle; transaction is the digest of the tick's tx set.
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

// K12 over a caller-sorted concatenation — the testnet-canonical spectrum/universe digest (NOT the mainnet
// 2^24-leaf merkle, which is infeasible and needless for a self-contained chain).
export function canonicalDigest(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }

  return k12Bytes(buf);
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
export function buildTickVote(c: Computor, epoch: number, tick: number, d: TickStateDigests): Uint8Array {
  const buf = new Uint8Array(TICK_SIZE);
  const dv = new DataView(buf.buffer);

  dv.setUint16(0, c.index, true);
  dv.setUint16(2, epoch & 0xffff, true);
  dv.setUint32(4, tick >>> 0, true);
  // [8..16] time, [16..32] resource-testing / tx-body u32 digests — left zero (deterministic)

  buf.set(d.spectrum, 32);
  buf.set(d.universe, 64);
  buf.set(d.computer, 96);
  buf.set(saltedDigest(c.publicKey, d.spectrum), 128);
  buf.set(saltedDigest(c.publicKey, d.universe), 160);
  buf.set(saltedDigest(c.publicKey, d.computer), 192);
  buf.set(d.transaction, 224);
  buf.set(d.expectedNextTransaction, 256);

  // Domain-separate the signed message by XORing computorIndex with the Tick message type (qubic.cpp does the
  // same XOR before verifying). The transmitted struct keeps the plain index.
  dv.setUint16(0, (c.index ^ TICK_TYPE) & 0xffff, true);
  const digest = k12Bytes(buf.subarray(0, TICK_SIZE - SIG_SIZE));
  const signature = signSync(c.privateKey, c.publicKey, digest);
  dv.setUint16(0, c.index, true);
  buf.set(signature, TICK_SIZE - SIG_SIZE);
  return buf;
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

// Does a vote commit to the etalon (canonical) state digests? The aligned-vote count for quorum.
export function voteIsAligned(vote: Uint8Array, d: TickStateDigests): boolean {
  return bytesEq(vote.subarray(32, 64), d.spectrum)
    && bytesEq(vote.subarray(64, 96), d.universe)
    && bytesEq(vote.subarray(96, 128), d.computer)
    && bytesEq(vote.subarray(224, 256), d.transaction);
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
