// SpectrumLedger (spectrum.ts) in isolation — no Sim. The entity-balance ledger + the spectrum merkle extracted
// from the Sim god object: energy/increaseEnergy/decreaseEnergy, nextId/prevId iteration, the digest + proof.
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex } from "../src/k12";
import { SpectrumLedger } from "../src/spectrum";

beforeAll(async () => {
  await initK12(); // the digest/proof hash through K12
});

function id(firstByte: number): Uint8Array {
  const a = new Uint8Array(32);
  a[0] = firstByte;
  return a;
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

test("nextId / prevId walk the occupied ids in order; zero when none", () => {
  const s = new SpectrumLedger();
  for (const b of [0x10, 0x20, 0x30]) {
    s.increaseEnergy(id(b), 1n, 0);
  }

  expect(toHex(s.nextId(id(0x10)))).toBe(toHex(id(0x20)));
  expect(toHex(s.prevId(id(0x30)))).toBe(toHex(id(0x20)));
  expect(s.nextId(id(0x30)).every((x) => x === 0)).toBe(true); // nothing after the last
  expect(s.prevId(id(0x10)).every((x) => x === 0)).toBe(true); // nothing before the first
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

  const miss = s.spectrumProof(id(9));
  expect(miss.index).toBe(-1);
  expect(miss.siblings.length).toBe(0);
});
