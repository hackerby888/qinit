// Phase 3 — assets/shares: issueAsset, isAssetIssued, numberOfShares, numberOfPossessedShares,
// transferShareOwnershipAndPossession, and distributeDividends. Driven through the Token + Dividend fixtures
// (real qinit-built wasm), asserting the universe (issuance + holdings) the C++ semantics produce. Assets are
// NOT in the contract-state digest (they live in the universe), so these assert return values + holdings.
import { test, expect } from "bun:test";
import { initK12, deriveKeysSync, signSync, k12Bytes } from "../src/k12";
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

// ShareManager Acquire/Release input: { uint64 name; id issuer; id holder; sint64 shares; uint16 mgmt; sint64 fee }
function mgmtIn(name: bigint, issuer: Uint8Array, holder: Uint8Array, shares: bigint, mgmt: number, fee: bigint): Uint8Array {
  const b = new Uint8Array(96);
  const d = new DataView(b.buffer);
  d.setBigUint64(0, name, true);
  b.set(issuer.subarray(0, 32), 8);
  b.set(holder.subarray(0, 32), 40);
  d.setBigInt64(72, shares, true);
  d.setUint16(80, mgmt, true);
  d.setBigInt64(88, fee, true);
  return b;
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

test("a wasm contract can call qpi.acquireShares (the lhost import resolves end-to-end)", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(29, await wasm("ShareManager")); // built --slot 29 -> SELF = id(29)
  const SELF = cid(29);

  sim.procedure(29, 1, issueIn(TOKEN, 1000n)); // issue an asset managed by SELF (contract 29)

  const acq = new Uint8Array(96); // { uint64 name; id issuer; id holder; sint64 shares; uint16 srcMgmt; sint64 fee }
  const adv = new DataView(acq.buffer);
  adv.setBigUint64(0, TOKEN, true);
  acq.set(SELF, 8); // issuer
  acq.set(SELF, 40); // holder (owner == possessor)
  adv.setBigInt64(72, 1n, true); // shares
  adv.setUint16(80, 28, true); // srcMgmt — the asset is actually managed by 29, so the host denies
  adv.setBigInt64(88, 0n, true); // fee
  sim.procedure(29, 2, acq); // Acquire -> qpi.acquireShares through wasm -> lhost -> the host

  // the call reached qpi.acquireShares end-to-end (no LinkError); the host denied it -> INVALID_AMOUNT
  expect(i64(sim.query(29, 1))).toBe(INVALID_AMOUNT);
});

test("the approve path: PRE_RELEASE_SHARES lets another contract acquire management rights (through wasm)", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("ShareApprover")); // built --slot 28: issues + approves releases via PRE_RELEASE_SHARES
  sim.deploy(29, await wasm("ShareManager")); // built --slot 29: acquires
  const A = cid(28); // the source manager == issuer == holder

  sim.procedure(28, 1, issueIn(TOKEN, 1000n)); // owner = possessor = id(28), managed by contract 28
  expect(sharesByMgmt(sim, 28)).toBe(1000n);

  const acq = new Uint8Array(96);
  const adv = new DataView(acq.buffer);
  adv.setBigUint64(0, TOKEN, true);
  acq.set(A, 8); // issuer
  acq.set(A, 40); // holder (owner == possessor == id(28))
  adv.setBigInt64(72, 400n, true); // shares
  adv.setUint16(80, 28, true); // srcMgmt
  adv.setBigInt64(88, 0n, true); // fee
  sim.procedure(29, 2, acq); // Acquire -> acquireShares -> PRE_RELEASE_SHARES on 28 approves -> rights move to 29

  expect(i64(sim.query(29, 1))).toBe(0n); // acquireShares returned the paid fee (0) on success
  expect(sharesByMgmt(sim, 29)).toBe(400n); // 400 now managed by the acquirer
  expect(sharesByMgmt(sim, 28)).toBe(600n); // 600 still managed by the issuer
});

test("acquire with a non-zero fee (through wasm): the approver charges, the acquirer pays", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("ShareApprover"));
  sim.deploy(29, await wasm("ShareManager"));
  const A = cid(28);

  sim.procedure(28, 1, issueIn(TOKEN, 1000n));
  const setFee = new Uint8Array(8);
  new DataView(setFee.buffer).setBigInt64(0, 10n, true);
  sim.procedure(28, 2, setFee); // SetFee(10): PRE_RELEASE_SHARES now requests a fee of 10
  sim.fund(cid(29), 100n); // the acquirer needs balance to pay the fee

  sim.procedure(29, 2, mgmtIn(TOKEN, A, A, 400n, 28, 10n)); // Acquire with offeredFee 10

  expect(i64(sim.query(29, 1))).toBe(10n); // acquireShares returned the paid fee
  expect(sim.balanceOf(28)).toBe(10n); // the approver received it
  expect(sim.balanceOf(29)).toBe(90n); // the acquirer paid it
  expect(sharesByMgmt(sim, 29)).toBe(400n);
});

test("release management rights back through wasm (PRE_ACQUIRE_SHARES approves)", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("ShareApprover"));
  sim.deploy(29, await wasm("ShareManager"));
  const A = cid(28);

  sim.procedure(28, 1, issueIn(TOKEN, 1000n));
  sim.procedure(29, 2, mgmtIn(TOKEN, A, A, 400n, 28, 0n)); // acquire 400 -> managed by 29
  expect(sharesByMgmt(sim, 29)).toBe(400n);

  sim.procedure(29, 3, mgmtIn(TOKEN, A, A, 400n, 28, 0n)); // release 400 back to 28 (its PRE_ACQUIRE_SHARES approves)

  expect(i64(sim.query(29, 1))).toBe(0n);
  expect(sharesByMgmt(sim, 29)).toBe(0n); // released
  expect(sharesByMgmt(sim, 28)).toBe(1000n); // all back to the issuer
});

test("newly-exposed qpi wasm imports resolve: dayOfWeek + signatureValidity real, IPO/mining/oracle stubbed", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(29, await wasm("ApiProbe")); // calls all 9 newly-exposed qpi methods

  // Probe = dayOfWeek(2024-01-01) + ipoBidPrice(stub -1) + getOracleQueryStatus(stub 0)
  const p = new Uint8Array(24); // { uint8 year; uint8 month; uint8 day; ...; }
  p[0] = 24; p[1] = 1; p[2] = 1;
  const dow = (new Date(Date.UTC(2024, 0, 1)).getUTCDay() + 4) % 7; // qubic dayOfWeek (0 = Wednesday)
  expect(i64(sim.query(29, 1, p))).toBe(BigInt(dow) - 1n); // every import resolved; the stubs returned defaults

  // Verify = signatureValidity against a real FourQ signature
  const kp = deriveKeysSync("z".repeat(55));
  const digest = k12Bytes(new Uint8Array([1, 2, 3]));
  const sig = signSync(kp.privateKey, kp.publicKey, digest);
  const v = new Uint8Array(128); // { id entity; id digest; Array<sint8,64> sig }
  v.set(kp.publicKey, 0);
  v.set(digest, 32);
  v.set(sig, 64);
  expect(i64(sim.query(29, 2, v))).toBe(1n); // a valid signature verifies through wasm -> lhost -> host
});
