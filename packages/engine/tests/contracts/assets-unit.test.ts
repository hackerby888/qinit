// AssetLedger (assets.ts) in isolation — no Sim. A fake AssetHost supplies only the contract-id derivation, so
// the issuance / share-transfer / management-rights / universe-merkle logic is exercised directly.
import { test, expect, beforeAll } from "bun:test";
import { initK12, toHex } from "../../src/k12";
import { AssetLedger } from "../../src/assets";
import { contractId } from "../support/helpers";

beforeAll(async () => {
  await initK12(); // the universe digest/proof hash through K12
});

function userId(firstByte: number): Uint8Array {
  const a = new Uint8Array(32);
  a[0] = firstByte;
  return a;
}

const NAME = 0x5851n; // "QX" packed little-endian ASCII (Q=0x51, X=0x58)

function ledger(): AssetLedger {
  return new AssetLedger({ contractId });
}

test("issueAsset: mints all shares to the issuer; validates name + issuer", () => {
  const a = ledger();
  const iss = contractId(1);
  expect(a.issueAsset(1, NAME, iss, 2, 1000n, 0n, iss)).toBe(1000n);
  expect(a.isAssetIssued(iss, NAME)).toBe(true);
  expect(a.numberOfPossessedShares(NAME, iss, iss, iss, 1, 1)).toBe(1000n);

  expect(a.issueAsset(1, NAME, iss, 2, 1000n, 0n, iss)).toBe(0n); // already issued
  expect(a.issueAsset(1, 0x0030n, iss, 2, 1n, 0n, iss)).toBe(0n); // name first byte not A-Z
  expect(a.issueAsset(1, 0x5852n, userId(9), 2, 1n, 0n, userId(8))).toBe(0n); // issuer != contract && != invocator
});

test("transferShareOwnershipAndPossession: moves shares to a new owner managed by the contract", () => {
  const a = ledger();
  const iss = contractId(1);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);
  const bob = userId(0xbb);

  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 400n, bob)).toBe(600n); // remaining
  expect(a.numberOfPossessedShares(NAME, iss, iss, iss, 1, 1)).toBe(600n);
  expect(a.numberOfPossessedShares(NAME, iss, bob, bob, 1, 1)).toBe(400n);

  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 9999n, bob)).toBe(
    600n - 9999n,
  ); // insufficient -> no move
  expect(a.numberOfPossessedShares(NAME, iss, iss, iss, 1, 1)).toBe(600n);
});

test("transferShareManagementRights: moves the managing contract for a holding", () => {
  const a = ledger();
  const iss = contractId(1);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);

  expect(a.transferShareManagementRights(NAME, iss, iss, iss, 1, 2, 250n)).toBe(true);
  expect(a.numberOfPossessedShares(NAME, iss, iss, iss, 1, 1)).toBe(750n); // managed by 1
  expect(a.numberOfPossessedShares(NAME, iss, iss, iss, 2, 2)).toBe(250n); // managed by 2

  expect(a.transferShareManagementRights(NAME, iss, iss, iss, 1, 2, 9999n)).toBe(false); // insufficient
  expect(a.transferShareManagementRights(NAME, iss, iss, iss, 1, 2, 0n)).toBe(false); // non-positive
});

test("numberOfShares sums holdings via the any-owner/any-possessor selectors", () => {
  const a = ledger();
  const iss = contractId(1);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);
  a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 300n, userId(0xcc));

  const assetSel = new Uint8Array(40); // Asset { id(32) assetName(8) }
  assetSel.set(iss, 0);
  new DataView(assetSel.buffer).setBigUint64(32, NAME, true);
  const anyOwn = new Uint8Array(36); // AssetOwnershipSelect with anyOwner + anyManagingContract flags set
  anyOwn[34] = 1;
  anyOwn[35] = 1;
  const anyPos = new Uint8Array(36);
  anyPos[34] = 1;
  anyPos[35] = 1;

  expect(a.numberOfShares(assetSel, anyOwn, anyPos)).toBe(1000n); // both holdings
});

test("getUniverseDigest is deterministic and changes with a holding; proofs carry 24 siblings", () => {
  const build = () => {
    const a = ledger();
    const iss = contractId(1);
    a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);
    return a;
  };
  const x = build();
  const y = build();
  expect(toHex(x.getUniverseDigest())).toBe(toHex(y.getUniverseDigest())); // same ops -> same root

  const before = toHex(x.getUniverseDigest());
  x.transferShareOwnershipAndPossession(
    1,
    NAME,
    contractId(1),
    contractId(1),
    contractId(1),
    100n,
    userId(0xdd),
  );
  expect(toHex(x.getUniverseDigest())).not.toBe(before);

  const proofs = x.universeProofOwned(contractId(1));
  expect(proofs.length).toBeGreaterThanOrEqual(1);
  expect(proofs[0].siblings.length).toBe(24); // ASSETS_DEPTH
  expect(proofs[0].record.length).toBe(48); // AssetRecord
});

test("assetUniverse snapshots issued assets with the name decoded", () => {
  const a = ledger();
  const iss = contractId(1);
  a.issueAsset(1, NAME, iss, 2, 1000n, 0n, iss);

  const snap = a.assetUniverse();
  expect(snap.length).toBe(1);
  expect(snap[0].name).toBe("QX");
  expect(snap[0].decimals).toBe(2);
  expect(snap[0].totalShares).toBe("1000");
});

test("enumerate: possession (kind 1) + ownership (kind 0) records, with a possessor filter", () => {
  const a = ledger();
  const iss = contractId(1);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);
  a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 300n, userId(0xcc)); // iss 700, 0xcc 300

  const assetSel = new Uint8Array(40);
  assetSel.set(iss, 0);
  new DataView(assetSel.buffer).setBigUint64(32, NAME, true);
  const any = () => {
    const s = new Uint8Array(36);
    s[34] = 1;
    s[35] = 1;
    return s;
  }; // anyId + anyMgmt

  // possession: every matching holding, keyed by possessor
  const poss = new Map(
    a
      .enumerate(assetSel, any(), any(), 1)
      .map((e) => [toHex(e.possessor.subarray(0, 32)), e.shares]),
  );
  expect(poss.size).toBe(2);
  expect(poss.get(toHex(iss.subarray(0, 32)))).toBe(700n);
  expect(poss.get(toHex(userId(0xcc).subarray(0, 32)))).toBe(300n);

  // ownership: distinct owner + total owned shares
  const own = new Map(
    a.enumerate(assetSel, any(), any(), 0).map((e) => [toHex(e.owner.subarray(0, 32)), e.shares]),
  );
  expect(own.size).toBe(2);
  expect(own.get(toHex(iss.subarray(0, 32)))).toBe(700n);

  // a specific possessor in the select narrows to that one record
  const posSel = new Uint8Array(36);
  posSel.set(userId(0xcc), 0);
  posSel[35] = 1; // anyMgmt, specific possessor (anyId stays 0)
  const filtered = a.enumerate(assetSel, any(), posSel, 1);
  expect(filtered.length).toBe(1);
  expect(filtered[0].shares).toBe(300n);
});
