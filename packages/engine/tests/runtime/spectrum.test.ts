// SpectrumLedger (spectrum.ts) in isolation — no QubicSimulator. The entity-balance ledger + the spectrum merkle extracted
// from the simulator: energy/increaseEnergy/decreaseEnergy, nextId/prevId iteration, the digest + proof.
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex } from "../../src/support/k12";
import { SpectrumLedger } from "../../src/ledger/spectrum";
import { rootFromSiblings } from "../../src/ledger/merkle";

beforeAll(async () => {
    await initK12(); // the digest/proof hash through K12
});

// The host stands in for core's `system.tick`; tests move it to check what the entity records.
function ledger(): { spectrum: SpectrumLedger; setTick: (tick: number) => void } {
    let tick = 0;
    const spectrum = new SpectrumLedger({ tick: () => tick });
    return { spectrum, setTick: (value) => (tick = value) };
}

function id(firstByte: number): Uint8Array {
    const a = new Uint8Array(32);
    a[0] = firstByte;
    return a;
}

function slottedId(firstWord: number, marker: number): Uint8Array {
    const value = new Uint8Array(32);
    new DataView(value.buffer).setUint32(0, firstWord, true);
    value[31] = marker;
    return value;
}

test("energy = incomingAmount - outgoingAmount; records are created on first touch", () => {
    const { spectrum, setTick } = ledger();
    const a = id(1);
    expect(spectrum.spectrumIndex(a)).toBe(-1);
    expect(spectrum.getEntity(a)).toBeNull();

    setTick(5);
    spectrum.increaseEnergy(a, 1000n);
    setTick(6);
    expect(spectrum.decreaseEnergy(spectrum.spectrumIndex(a), 250n)).toBe(true);
    expect(spectrum.energy(spectrum.spectrumIndex(a))).toBe(750n);

    const e = spectrum.getEntity(a)!;
    expect(e.incomingAmount).toBe(1000n);
    expect(e.outgoingAmount).toBe(250n);
    expect(e.numberOfIncomingTransfers).toBe(1);
    expect(e.numberOfOutgoingTransfers).toBe(1);
    expect(e.latestIncomingTransferTick).toBe(5);
    expect(e.latestOutgoingTransferTick).toBe(6);
    expect(spectrum.numberOfEntities).toBe(1);
});

test("decreaseEnergy refuses to overdraw and leaves the record untouched", () => {
    const { spectrum } = ledger();
    const a = id(1);
    spectrum.increaseEnergy(a, 100n);
    const index = spectrum.spectrumIndex(a);

    expect(spectrum.decreaseEnergy(index, 101n)).toBe(false);
    expect(spectrum.energy(index)).toBe(100n);
    expect(spectrum.getEntity(a)!.numberOfOutgoingTransfers).toBe(0);

    expect(spectrum.decreaseEnergy(index, 100n)).toBe(true); // the whole balance is spendable
    expect(spectrum.energy(index)).toBe(0n);
});

test("decreaseEnergy never creates a record, and a negative amount is refused", () => {
    const { spectrum } = ledger();
    expect(spectrum.decreaseEnergy(spectrum.spectrumIndex(id(1)), 5n)).toBe(false);
    expect(spectrum.numberOfEntities).toBe(0);

    spectrum.increaseEnergy(id(1), 100n);
    expect(spectrum.decreaseEnergy(spectrum.spectrumIndex(id(1)), -1n)).toBe(false);
    expect(spectrum.energy(spectrum.spectrumIndex(id(1)))).toBe(100n);
});

// The mirror of the case above. increaseEnergy takes an unvalidated amount straight from
// QubicSimulator.fund, so a negative one would destroy Qu rather than create it.
test("increaseEnergy refuses a negative amount", () => {
    const { spectrum } = ledger();
    const a = id(1);
    spectrum.increaseEnergy(a, 100n);

    spectrum.increaseEnergy(a, -1n);
    expect(spectrum.energy(spectrum.spectrumIndex(a))).toBe(100n);
    expect(spectrum.getEntity(a)!.numberOfIncomingTransfers).toBe(1);
});

// totalAmount is the explorer's circulatingSupply, and nothing else recomputes it — so a wrong sign
// here is a wrong number on the API with no other symptom.
test("totalAmount is the sum of balances, not of gross flows", () => {
    const { spectrum } = ledger();
    const a = id(1);
    const b = id(2);
    spectrum.increaseEnergy(a, 100n);
    spectrum.increaseEnergy(b, 40n);
    expect(spectrum.totalAmount()).toBe(140n);

    // Moving Qu between two entities leaves the total alone: a's outgoing has to cancel b's incoming.
    spectrum.decreaseEnergy(spectrum.spectrumIndex(a), 30n);
    spectrum.increaseEnergy(b, 30n);
    expect(spectrum.totalAmount()).toBe(140n);
    expect(spectrum.energy(spectrum.spectrumIndex(a))).toBe(70n);
});

test("zero identity is not inserted into the spectrum", () => {
    const expectedDigest = toHex(ledger().spectrum.getSpectrumDigest());
    const { spectrum } = ledger();
    const zero = new Uint8Array(32);

    spectrum.increaseEnergy(zero, 100n);
    expect(spectrum.decreaseEnergy(spectrum.spectrumIndex(zero), 50n)).toBe(false);

    expect(spectrum.numberOfEntities).toBe(0);
    expect(spectrum.getEntity(zero)).toBeNull();
    expect(spectrum.spectrumIndex(zero)).toBe(-1);
    expect(toHex(spectrum.getSpectrumDigest())).toBe(expectedDigest);
});

test("collisions use Core's first-u32 slot and linear probing", () => {
    const { spectrum } = ledger();
    const first = slottedId(0xab123456, 1);
    const second = slottedId(0xab123456, 2);
    const third = slottedId(0xab123456, 3);
    const end = slottedId(0xffffffff, 4);
    const wrapped = slottedId(0xffffffff, 5);

    spectrum.increaseEnergy(first, 10n);
    spectrum.increaseEnergy(second, 20n);
    spectrum.increaseEnergy(third, 30n);
    spectrum.increaseEnergy(end, 40n);
    spectrum.increaseEnergy(wrapped, 50n);

    expect(spectrum.spectrumIndex(first)).toBe(0x123456);
    expect(spectrum.spectrumIndex(second)).toBe(0x123457);
    expect(spectrum.spectrumIndex(third)).toBe(0x123458);
    expect(spectrum.spectrumIndex(end)).toBe(0xffffff);
    expect(spectrum.spectrumIndex(wrapped)).toBe(0);

    const secondProof = spectrum.spectrumProof(second);
    expect(secondProof.index).toBe(0x123457);
    expect(toHex(rootFromSiblings(secondProof.record, secondProof.index, secondProof.siblings))).toBe(toHex(spectrum.getSpectrumDigest()));
});

test("nextId / prevId walk occupied spectrum slots", () => {
    const { spectrum } = ledger();
    const first = slottedId(0x10, 1);
    const middle = slottedId(0x200, 2);
    const last = slottedId(0x300, 3);
    for (const entityId of [last, first, middle]) {
        spectrum.increaseEnergy(entityId, 1n);
    }

    expect(toHex(spectrum.nextId(new Uint8Array(32)))).toBe(toHex(first));
    expect(toHex(spectrum.nextId(first))).toBe(toHex(middle));
    expect(toHex(spectrum.nextId(middle))).toBe(toHex(last));
    expect(toHex(spectrum.prevId(last))).toBe(toHex(middle));
    expect(spectrum.nextId(last).every((x) => x === 0)).toBe(true);
    expect(spectrum.prevId(first).every((x) => x === 0)).toBe(true);
});

test("getSpectrumDigest is deterministic and changes with balance", () => {
    const build = () => {
        const { spectrum } = ledger();
        spectrum.increaseEnergy(id(1), 100n);
        spectrum.increaseEnergy(id(2), 200n);
        return spectrum;
    };
    const a = build();
    const b = build();
    expect(toHex(a.getSpectrumDigest())).toBe(toHex(b.getSpectrumDigest())); // same ops -> same root

    const before = toHex(a.getSpectrumDigest());
    a.increaseEnergy(id(1), 1n);
    expect(toHex(a.getSpectrumDigest())).not.toBe(before); // a balance change moves the root
});

test("spectrumProof: 24 siblings for a known entity, index -1 for an unknown one", () => {
    const { spectrum } = ledger();
    spectrum.increaseEnergy(id(1), 100n);
    spectrum.increaseEnergy(id(2), 200n);

    const p = spectrum.spectrumProof(id(1));
    expect(p.index).toBeGreaterThanOrEqual(0);
    expect(p.siblings.length).toBe(24); // SPECTRUM_DEPTH
    expect(p.record.length).toBe(64); // EntityRecord
    expect(toHex(rootFromSiblings(p.record, p.index, p.siblings))).toBe(toHex(spectrum.getSpectrumDigest()));

    const miss = spectrum.spectrumProof(id(9));
    expect(miss.index).toBe(-1);
    expect(miss.siblings.length).toBe(0);
});
