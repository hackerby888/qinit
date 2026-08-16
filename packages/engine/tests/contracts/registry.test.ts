// ContractRegistry's Wasm-free store and computer digest in isolation.
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex } from "../../src/support/k12";
import { ContractRegistry } from "../../src/contract/registry";
import { FeeManager } from "../../src/contract/fees";
import { TraceRecorder } from "../../src/logging/trace";

beforeAll(async () => {
    await initK12(); // computerDigest hashes through K12
});

function registry(): ContractRegistry {
    return new ContractRegistry(new FeeManager("off"), new TraceRecorder());
}

test("empty registry: no contracts, empty slot list, empty dirty set", () => {
    const r = registry();
    expect(r.get(5)).toBeUndefined();
    expect(r.has(5)).toBe(false);
    expect(r.slots(true)).toEqual([]);
    expect(r.contracts.size).toBe(0);
    expect(r.dirty.size).toBe(0);

    r.dirty.add(3); // the public dirty set the qpi markDirty writes to
    expect(r.dirty.has(3)).toBe(true);
});

test("computerDigest over an empty registry is deterministic", () => {
    const a = registry().getComputerDigest();
    const b = registry().getComputerDigest();
    expect(toHex(a)).toBe(toHex(b)); // the merkle root of zero contract-state leaves
    expect(a.length).toBe(32);
});
