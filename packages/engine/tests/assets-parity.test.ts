// Node-parity behaviors of the record-table AssetLedger (assets/assets.h + qpi_asset_impl.h semantics that
// the flat-holdings model could not express): zero-share record retention, burn-to-zero-id (refused for
// contract shares), exact qpi return codes, LIFO index-list enumeration order, and the possession sweep
// distributeDividends iterates.
import { test, expect, beforeAll } from "bun:test";
import { initK12 } from "../src/k12";
import { AssetLedger, packAssetName } from "../src/assets";
import { Asset, AssetSelect } from "../src/abi";
import { contractId } from "./helpers";

beforeAll(async () => {
  await initK12();
});

const NAME = packAssetName("QX");
const MAX_AMOUNT = 1000000000000000n;
const INVALID_AMOUNT = -9223372036854775808n;

function userId(firstByte: number): Uint8Array {
  const a = new Uint8Array(32);
  a[0] = firstByte;
  return a;
}

function ledger(): AssetLedger {
  return new AssetLedger({ contractId });
}

function assetBytes(issuer: Uint8Array, name: bigint): Uint8Array {
  const a = Asset.alloc();
  a.issuer = issuer;
  a.assetName = name;
  return a.bytes;
}

function anySelect(): Uint8Array {
  const s = AssetSelect.alloc();
  s.anyId = 1;
  s.anyMgmt = 1;
  return s.bytes;
}

test("zero-share records are retained: a full transfer leaves the source record at 0, still counted", () => {
  const a = ledger();
  const iss = contractId(1);
  const bob = userId(0xbb);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);

  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 1000n, bob)).toBe(0n); // remaining = 0
  expect(a.numberOfPossessedShares(NAME, iss, iss, iss, 1, 1)).toBe(0n); // record still resolvable, at 0
  expect(a.numberOfPossessedShares(NAME, iss, bob, bob, 1, 1)).toBe(1000n);

  // the emptied record still enumerates (the node never deletes records)
  const owners = a.enumerate(assetBytes(iss, NAME), anySelect(), anySelect(), 0);
  expect(owners.length).toBe(2);
});

test("burn: zero destination subtracts from the source; contract shares (zero-id issuer) refuse to burn", () => {
  const a = ledger();
  const iss = contractId(1);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);

  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 300n, new Uint8Array(32))).toBe(700n);
  expect(a.numberOfShares(assetBytes(iss, NAME), anySelect(), anySelect())).toBe(700n);

  // contract shares: issuer is the zero id — burning them fails at the asset layer (INVALID_AMOUNT)
  const CS = packAssetName("CTR");
  a.mintContractShares(1, CS, 676n);
  const zero = new Uint8Array(32);
  expect(a.transferShareOwnershipAndPossession(1, CS, zero, zero, zero, 10n, new Uint8Array(32))).toBe(INVALID_AMOUNT);
  expect(a.numberOfShares(assetBytes(zero, CS), anySelect(), anySelect())).toBe(676n);
});

test("qpi transfer return codes: range, missing records, foreign management, insufficient", () => {
  const a = ledger();
  const iss = contractId(1);
  const bob = userId(0xbb);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);

  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 0n, bob)).toBe(-(MAX_AMOUNT + 1n));
  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, MAX_AMOUNT + 1n, bob)).toBe(-(MAX_AMOUNT + 1n));
  expect(a.transferShareOwnershipAndPossession(1, packAssetName("NOPE"), iss, iss, iss, 5n, bob)).toBe(-5n); // no issuance
  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, bob, bob, 5n, iss)).toBe(-5n); // owner has no record
  expect(a.transferShareOwnershipAndPossession(2, NAME, iss, iss, iss, 5n, bob)).toBe(-5n); // managed by 1, caller 2
  expect(a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 1500n, bob)).toBe(1000n - 1500n); // insufficient
});

test("management-rights move preserves identities and splits records by managing contract", () => {
  const a = ledger();
  const iss = contractId(1);
  const bob = userId(0xbb);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);
  a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 400n, bob);

  expect(a.transferShareManagementRights(NAME, iss, bob, bob, 1, 7, 150n)).toBe(true);
  expect(a.numberOfPossessedShares(NAME, iss, bob, bob, 1, 1)).toBe(250n);
  expect(a.numberOfPossessedShares(NAME, iss, bob, bob, 7, 7)).toBe(150n);

  // insufficient on the source pair fails without moving anything
  expect(a.transferShareManagementRights(NAME, iss, bob, bob, 1, 7, 9999n)).toBe(false);
  expect(a.numberOfPossessedShares(NAME, iss, bob, bob, 7, 7)).toBe(150n);
});

test("enumeration order is the node's LIFO index-list order (newest ownership first)", () => {
  const a = ledger();
  const iss = contractId(1);
  a.issueAsset(1, NAME, iss, 0, 1000n, 0n, iss);
  const bob = userId(0xbb);
  const carol = userId(0xcc);
  a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 100n, bob);
  a.transferShareOwnershipAndPossession(1, NAME, iss, iss, iss, 200n, carol);

  const owners = a.enumerate(assetBytes(iss, NAME), anySelect(), anySelect(), 0);
  expect(owners.map((o) => o.owner[0])).toEqual([0xcc, 0xbb, iss[0]]); // newest record prepends
  expect(owners.map((o) => o.shares)).toEqual([200n, 100n, 700n]);
});

test("possessionsOf sweeps every possession record of an asset (the distributeDividends receiver set)", () => {
  const a = ledger();
  const zero = new Uint8Array(32);
  const CS = packAssetName("CTR");
  const bob = userId(0xbb);
  const carol = userId(0xcc);
  a.mintContractShares(1, CS, 676n);
  a.transferShareOwnershipAndPossession(1, CS, zero, zero, zero, 500n, bob);
  a.transferShareOwnershipAndPossession(1, CS, zero, zero, zero, 176n, carol);
  a.transferShareManagementRights(CS, zero, bob, bob, 1, 7, 100n);

  const ps = a.possessionsOf(zero, CS);
  const total = ps.reduce((s, p) => s + p.shares, 0n);
  expect(total).toBe(676n); // zero-share NULL holder + bob@1 + bob@7 + carol@1
  const bobTotal = ps.filter((p) => p.possessor[0] === 0xbb).reduce((s, p) => s + p.shares, 0n);
  expect(bobTotal).toBe(500n);
});
