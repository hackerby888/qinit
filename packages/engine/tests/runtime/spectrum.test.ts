// SpectrumLedger (spectrum.ts) in isolation — no QubicSimulator. The entity-balance ledger + the spectrum merkle extracted
// from the simulator: energy/increaseEnergy/decreaseEnergy, nextId/prevId iteration, the digest + proof.
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex } from "../../src/support/k12";
import { SpectrumLedger } from "../../src/ledger/spectrum";
import { rootFromSiblings } from "../../src/ledger/merkle";

beforeAll(async () => {
    await initK12(); // the digest/proof hash through K12
});

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
    const s = new SpectrumLedger();
    const a = id(1);
    expect(s.energy(a)).toBe(0n);
    expect(s.entityOf(a)).toBeNull();

    s.increaseEnergy(a, 1000n, 5);
    s.decreaseEnergy(a, 250n, 6);
    expect(s.energy(a)).toBe(750n);

    const e = s.entityOf(a)!;
    expect(e.incomingAmount).toBe(1000n);
    expect(e.outgoingAmount).toBe(250n);
    expect(e.numberOfIncomingTransfers).toBe(1);
    expect(e.numberOfOutgoingTransfers).toBe(1);
    expect(e.latestIncomingTransferTick).toBe(5);
    expect(e.latestOutgoingTransferTick).toBe(6);
    expect(s.size).toBe(1);
});

test("zero identity is not inserted into the spectrum", () => {
    const empty = new SpectrumLedger();
    const expectedDigest = toHex(empty.getSpectrumDigest());
    const spectrum = new SpectrumLedger();
    const zero = new Uint8Array(32);

    spectrum.increaseEnergy(zero, 100n, 5);
    spectrum.decreaseEnergy(zero, 50n, 6);

    expect(spectrum.size).toBe(0);
    expect(spectrum.entityOf(zero)).toBeNull();
    expect(spectrum.energy(zero)).toBe(0n);
    expect(toHex(spectrum.getSpectrumDigest())).toBe(expectedDigest);
});

test("collisions use Core's first-u32 slot and linear probing", () => {
    const spectrum = new SpectrumLedger();
    const first = slottedId(0xab123456, 1);
    const second = slottedId(0xab123456, 2);
    const third = slottedId(0xab123456, 3);
    const end = slottedId(0xffffffff, 4);
    const wrapped = slottedId(0xffffffff, 5);

    spectrum.increaseEnergy(first, 10n, 1);
    spectrum.increaseEnergy(second, 20n, 1);
    spectrum.increaseEnergy(third, 30n, 1);
    spectrum.increaseEnergy(end, 40n, 1);
    spectrum.increaseEnergy(wrapped, 50n, 1);

    expect(spectrum.spectrumProof(first).index).toBe(0x123456);
    const secondProof = spectrum.spectrumProof(second);
    expect(secondProof.index).toBe(0x123457);
    expect(spectrum.spectrumProof(third).index).toBe(0x123458);
    expect(spectrum.spectrumProof(end).index).toBe(0xffffff);
    expect(spectrum.spectrumProof(wrapped).index).toBe(0);
    expect(toHex(rootFromSiblings(secondProof.record, secondProof.index, secondProof.siblings))).toBe(toHex(spectrum.getSpectrumDigest()));
});

test("nextId / prevId walk occupied spectrum slots", () => {
    const s = new SpectrumLedger();
    const first = slottedId(0x10, 1);
    const middle = slottedId(0x200, 2);
    const last = slottedId(0x300, 3);
    for (const entityId of [last, first, middle]) {
        s.increaseEnergy(entityId, 1n, 0);
    }

    expect(toHex(s.nextId(new Uint8Array(32)))).toBe(toHex(first));
    expect(toHex(s.nextId(first))).toBe(toHex(middle));
    expect(toHex(s.nextId(middle))).toBe(toHex(last));
    expect(toHex(s.prevId(last))).toBe(toHex(middle));
    expect(s.nextId(last).every((x) => x === 0)).toBe(true);
    expect(s.prevId(first).every((x) => x === 0)).toBe(true);
});

test("getSpectrumDigest is deterministic and changes with balance", () => {
    const build = () => {
        const s = new SpectrumLedger();
        s.increaseEnergy(id(1), 100n, 0);
        s.increaseEnergy(id(2), 200n, 0);
        return s;
    };
    const a = build();
    const b = build();
    expect(toHex(a.getSpectrumDigest())).toBe(toHex(b.getSpectrumDigest())); // same ops -> same root

    const before = toHex(a.getSpectrumDigest());
    a.increaseEnergy(id(1), 1n, 1);
    expect(toHex(a.getSpectrumDigest())).not.toBe(before); // a balance change moves the root
});

test("spectrumProof: 24 siblings for a known entity, index -1 for an unknown one", () => {
    const s = new SpectrumLedger();
    s.increaseEnergy(id(1), 100n, 0);
    s.increaseEnergy(id(2), 200n, 0);

    const p = s.spectrumProof(id(1));
    expect(p.index).toBeGreaterThanOrEqual(0);
    expect(p.siblings.length).toBe(24); // SPECTRUM_DEPTH
    expect(p.record.length).toBe(64); // EntityRecord
    expect(toHex(rootFromSiblings(p.record, p.index, p.siblings))).toBe(toHex(s.getSpectrumDigest()));

    const miss = s.spectrumProof(id(9));
    expect(miss.index).toBe(-1);
    expect(miss.siblings.length).toBe(0);
});
