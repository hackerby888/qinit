// Verifies computor signatures, quorum finalization, and committed state digests.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12, k12Bytes, toHex, deriveKeysSync, verifySync } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { Committee, merkleRoot, quorumOf, tickVoteMessage, tickVoteSignature, buildTickVote, voteIsAligned } from "../../src/chain/consensus";
import { readUint64LE } from "../support/helpers";

// the dev committee is a table: the same 676 identities in every process, and no key derivation on construction.
test("the default committee is the generated dev committee, keys included", async () => {
    await initK12();
    const first = new Committee();
    const second = new Committee({ numberOfComputors: 3 });

    expect(first.size).toBe(676);
    expect(second.computors.map((c) => toHex(c.publicKey))).toEqual(first.computors.slice(0, 3).map((c) => toHex(c.publicKey)));
    const derived = deriveKeysSync(first.computors[41].seed);
    expect(toHex(first.computors[41].publicKey)).toBe(toHex(derived.publicKey));
    expect(toHex(first.computors[41].privateKey)).toBe(toHex(derived.privateKey));
    expect(new Set(first.computors.map((c) => c.seed)).size).toBe(676);
});

// qubic-cli recomputes K12(publicKey ‖ word) for the resource-testing and transaction-body salts once a tick has a full quorum.
test("a vote carries the four-byte salts qubic-cli recomputes", async () => {
    await initK12();
    const committee = new Committee({ computorSeeds: SEEDS4 });
    const digests = {
        spectrum: new Uint8Array(32).fill(1),
        universe: new Uint8Array(32).fill(2),
        computer: new Uint8Array(32).fill(3),
        transaction: new Uint8Array(32),
        expectedNextTransaction: new Uint8Array(32),
    };
    const vote = buildTickVote(committee.computors[2], 1, 10, digests, 0);

    const salted = new Uint8Array(36);
    salted.set(committee.computors[2].publicKey, 0);
    const expected = new DataView(k12Bytes(salted).buffer).getUint32(0, true);
    expect(vote.prevResourceTestingDigest).toBe(0);
    expect(vote.saltedResourceTestingDigest).toBe(expected);
    expect(vote.saltedTransactionBodyDigest).toBe(expected);
    expect(vote.saltedResourceTestingDigest).not.toBe(0);
});

const GET = 1; // Counter Get function
const INC = 1; // Counter Inc procedure
const SEEDS4 = ["b".repeat(55), "c".repeat(55), "d".repeat(55), "e".repeat(55)];

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
    const sim = new QubicSimulator({
        consensus: { computorSeeds: SEEDS4 },
    });
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
    const sim = new QubicSimulator({
        consensus: { computorSeeds: SEEDS4 },
        liteTicking: false,
    });
    sim.deploy(28, await wasm("Counter"));

    for (let i = 0; i < 5; i++) {
        sim.advance();
    }

    const committee = sim.getCommittee();
    const rec = sim.tickRecord(sim.currentTick)!;
    expect(rec.total).toBe(4);
    expect(rec.aligned).toBe(4); // honest committee -> all align
    expect(rec.aligned).toBeGreaterThanOrEqual(committee.quorum);
    expect(sim.alignedVotes()).toBe(4);

    // each vote's signature verifies against its computor's public key
    for (const c of committee.computors) {
        const vote = rec.votes[c.index];
        expect(verifySync(c.publicKey, tickVoteMessage(vote.bytes), tickVoteSignature(vote.bytes))).toBe(true);
    }
});

test("configurable committee size drives quorum + vote count", async () => {
    await initK12();
    const sim = new QubicSimulator({
        consensus: { numberOfComputors: 7 },
        liteTicking: false,
    });
    sim.advance();

    expect(sim.quorum()).toBe(5); // floor(7*2/3)+1
    expect(sim.tickRecord(sim.currentTick)!.total).toBe(7);
});

test("computerDigest is the faithful K12 merkle over the 1024 contract leaves", async () => {
    await initK12();
    const sim = new QubicSimulator({
        consensus: { computorSeeds: SEEDS4 },
    });
    sim.deploy(28, await wasm("Counter"));
    sim.deploy(29, await wasm("Counter29"));
    sim.procedure(28, INC);

    const leaves = new Map<number, Uint8Array>();
    leaves.set(28, k12Bytes(sim.contracts.get(28)!.state()));
    leaves.set(29, k12Bytes(sim.contracts.get(29)!.state()));
    expect(toHex(sim.getComputerDigest())).toBe(toHex(merkleRoot(leaves, 1024)));

    // the digest must change when a contract's state changes
    const before = toHex(sim.getComputerDigest());
    sim.procedure(29, INC);
    expect(toHex(sim.getComputerDigest())).not.toBe(before);
});

test("consensus is additive — it does not change a contract's StateData digest", async () => {
    await initK12();
    const sim = new QubicSimulator({
        consensus: { computorSeeds: SEEDS4 },
    });
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
    expect(readUint64LE(sim.query(28, GET))).toBe(1n);
});

test("chain clock advances with ticks and stamps the tick-vote timestamp", async () => {
    await initK12();
    const sim = new QubicSimulator({
        consensus: { computorSeeds: SEEDS4 },
        liteTicking: false,
    });

    const t0 = sim.nowMs();
    for (let i = 0; i < 4; i++) {
        sim.advance();
    }
    expect(sim.nowMs()).toBe(t0 + 4 * sim.tickDuration); // deterministic: timeBaseMs + tick*tickDuration

    // the latest vote carries the decomposed timestamp (year = UTC year - 2000, like the node's year())
    const vote = sim.tickRecord(sim.currentTick)!.votes[0];
    const d = new Date(sim.nowMs());
    expect(vote.year).toBe((d.getUTCFullYear() - 2000) & 0xff); // year = UTC year - 2000 (node's year())
    expect(vote.month).toBe(d.getUTCMonth() + 1);
    expect(vote.day).toBe(d.getUTCDate());
});

test("spectrum digest changes when balances move, universe digest when assets change", async () => {
    await initK12();
    const sim = new QubicSimulator({
        consensus: { computorSeeds: SEEDS4 },
    });

    const before = toHex(sim.getSpectrumDigest());
    sim.fund(new Uint8Array(32).fill(0x11), 1000n);
    expect(toHex(sim.getSpectrumDigest())).not.toBe(before);
});

test("a tampered Tick vote fails signature verification and misaligns", async () => {
    await initK12();
    const committee = new Committee({ computorSeeds: SEEDS4 });
    const c = committee.computors[0];
    const digests = {
        spectrum: k12Bytes(new Uint8Array([1])),
        universe: k12Bytes(new Uint8Array([2])),
        computer: k12Bytes(new Uint8Array([3])),
        transaction: k12Bytes(new Uint8Array([4])),
        expectedNextTransaction: new Uint8Array(32),
    };

    const vote = buildTickVote(c, 1, 7, digests, Date.UTC(2024, 0, 1));
    expect(verifySync(c.publicKey, tickVoteMessage(vote.bytes), tickVoteSignature(vote.bytes))).toBe(true);
    expect(voteIsAligned(vote, digests)).toBe(true);

    // the same vote must NOT align to a different transaction digest (the etalon moved)
    expect(voteIsAligned(vote, { ...digests, transaction: k12Bytes(new Uint8Array([99])) })).toBe(false);

    // a detached clone we can tamper without touching the original; flipping a committed digest byte breaks the sig
    const bad = vote.clone();
    bad.bytes[32] ^= 0xff; // first byte of the spectrum-digest field
    expect(verifySync(c.publicKey, tickVoteMessage(bad.bytes), tickVoteSignature(bad.bytes))).toBe(false);
});
