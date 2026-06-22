// Phase 3 — assets/shares: issueAsset, isAssetIssued, numberOfShares, numberOfPossessedShares,
// transferShareOwnershipAndPossession, and distributeDividends. Driven through the Token + Dividend fixtures
// (real qinit-built wasm), asserting the universe (issuance + holdings) the C++ semantics produce. Assets are
// NOT in the contract-state digest (they live in the universe), so these assert return values + holdings.
import { test, expect } from "bun:test";
import { initK12 } from "../src/k12";
import { Sim } from "../src/sim";

const FIX = import.meta.dir + "/fixtures";
const TOKEN = 0x4e454b4f54n; // "TOKEN" (bytes T,O,K,E,N)

async function wasm(n: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${n}.wasm`).arrayBuffer());
}

function cid(slot: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
  return a;
}

function i64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(0, true);
}

function u64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
}

// ---- Token I/O encoders ----
function issueIn(name: bigint, shares: bigint): Uint8Array {
  const b = new Uint8Array(16); // { uint64 name; sint64 shares }
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, name, true);
  dv.setBigInt64(8, shares, true);
  return b;
}

function moveIn(name: bigint, to: Uint8Array, shares: bigint): Uint8Array {
  const b = new Uint8Array(48); // { uint64 name; id to; sint64 shares }
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, name, true);
  b.set(to.subarray(0, 32), 8);
  dv.setBigInt64(40, shares, true);
  return b;
}

function nameIn(name: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, name, true);
  return b;
}

function possIn(name: bigint, who: Uint8Array): Uint8Array {
  const b = new Uint8Array(40); // { uint64 name; id who }
  new DataView(b.buffer).setBigUint64(0, name, true);
  b.set(who.subarray(0, 32), 8);
  return b;
}

test("Token: issueAsset + isAssetIssued + numberOfShares", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Token")); // built --slot 28 -> SELF = id(28)
  const SELF = cid(28);

  expect(i64(sim.query(28, 2, nameIn(TOKEN)))).toBe(0n); // Issued() before
  expect(i64(sim.procedure(28, 1, issueIn(TOKEN, 1000n)))).toBe(1000n); // Issue -> result

  expect(i64(sim.query(28, 2, nameIn(TOKEN)))).toBe(1n); // Issued() after
  expect(i64(sim.query(28, 1, nameIn(TOKEN)))).toBe(1000n); // Total = numberOfShares(any,any)
  expect(i64(sim.query(28, 3, possIn(TOKEN, SELF)))).toBe(1000n); // Possessed(SELF)
});

test("Token: transferShareOwnershipAndPossession moves owner+possessor", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Token"));
  const SELF = cid(28);
  const R = new Uint8Array(32).fill(0xcd); // a non-contract recipient id

  sim.procedure(28, 1, issueIn(TOKEN, 1000n));

  expect(i64(sim.procedure(28, 2, moveIn(TOKEN, R, 300n)))).toBe(700n); // Move 300 -> source remaining
  expect(i64(sim.query(28, 1, nameIn(TOKEN)))).toBe(1000n); // total supply unchanged
  expect(i64(sim.query(28, 3, possIn(TOKEN, SELF)))).toBe(700n);
  expect(i64(sim.query(28, 3, possIn(TOKEN, R)))).toBe(300n);

  expect(i64(sim.procedure(28, 2, moveIn(TOKEN, R, 10000n)))).toBe(-9300n); // insufficient: 700 - 10000
});

test("Dividend: distributeDividends debits balance + guards on insufficient funds", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Dividend"));

  const distIn = (perShare: bigint): Uint8Array => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, perShare, true);
    return b;
  };

  sim.procedure(28, 1, new Uint8Array(0), { reward: 100n }); // Fund -> balance 100
  expect(sim.balanceOf(28)).toBe(100n);

  expect(u64(sim.procedure(28, 2, distIn(10n)))).toBe(1n); // 10 * NUMBER_OF_COMPUTORS(8) = 80 <= 100
  expect(sim.balanceOf(28)).toBe(20n);

  expect(u64(sim.procedure(28, 2, distIn(100n)))).toBe(0n); // 800 > 20 -> false, no debit
  expect(sim.balanceOf(28)).toBe(20n);
});

const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)

// Sum a holder's possessed shares grouped by the possession-managing contract.
function sharesByMgmt(sim: Sim, mgmt: number): bigint {
  let sum = 0n;
  for (const a of sim.assetUniverse()) {
    for (const h of a.holdings) {
      if (h.posMgmt === mgmt) {
        sum += BigInt(h.shares);
      }
    }
  }
  return sum;
}

test("transferShareManagementRights moves the managing contract; the possessor is unchanged", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Token")); // issues TOKEN owned + possessed by id(28), managed by contract 28
  const SELF = cid(28);
  sim.procedure(28, 1, issueIn(TOKEN, 1000n));

  // hand management of 400 shares to contract 30 (the QX-style custody split)
  expect(sim.transferShareManagementRights(TOKEN, SELF, SELF, SELF, 28, 30, 400n)).toBe(true);

  expect(sharesByMgmt(sim, 28)).toBe(600n); // 600 still managed by the issuer
  expect(sharesByMgmt(sim, 30)).toBe(400n); // 400 now managed by contract 30
  expect(i64(sim.query(28, 3, possIn(TOKEN, SELF)))).toBe(600n); // Token's own (contract-28-managed) possession dropped to 600

  // a partial move with insufficient shares under the source manager fails
  expect(sim.transferShareManagementRights(TOKEN, SELF, SELF, SELF, 28, 30, 1000n)).toBe(false);
});

test("acquireShares is denied when the source manager has no PRE_RELEASE_SHARES callback", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Token")); // Token implements no management-rights callbacks -> the node denies
  const SELF = cid(28);
  sim.procedure(28, 1, issueIn(TOKEN, 1000n));

  expect(sim.acquireShares(30, TOKEN, SELF, SELF, SELF, 100n, 28, 28, 0n)).toBe(INVALID_AMOUNT);
  expect(sharesByMgmt(sim, 28)).toBe(1000n); // unchanged — nothing acquired
});

test("acquireShares rejects owner != possessor (qpi keeps them equal)", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Token"));
  const SELF = cid(28);
  const OTHER = new Uint8Array(32).fill(0xcd);
  sim.procedure(28, 1, issueIn(TOKEN, 1000n));

  expect(sim.acquireShares(30, TOKEN, SELF, SELF, OTHER, 100n, 28, 28, 0n)).toBe(INVALID_AMOUNT);
});
