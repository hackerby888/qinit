// Contract-ABI struct layouts (abi.ts) — these views replace the hand-written byte offsets the host used to
// marshal the QpiContext header and the sysproc input/output buffers. The layouts feed entity/spectrum digests
// and the cross-contract call path, so they must match the core-lite C structs byte-for-byte: this pins each
// struct's SIZE + field offsets against qpi.h, and round-trips a write/read so a drift in the kit is caught here.
import { test, expect } from "bun:test";
import {
  QpiContext,
  Asset,
  AssetSelect,
  PreManagementRightsTransferInput,
  PreManagementRightsTransferOutput,
  PostIncomingTransferInput,
  ContractId,
} from "../../src/abi";

test("QpiContext is the 256-byte qpi.h header with named fields at their fixed offsets", () => {
  expect(QpiContext.SIZE).toBe(256);
  expect(QpiContext.OFFSETS).toMatchObject({
    currentContractIndex: 0,
    stackIndex: 4,
    currentContractId: 8,
    originator: 40,
    invocator: 72,
    invocationReward: 104,
    entryPoint: 112,
  });

  const ctx = QpiContext.alloc();
  const orig = new Uint8Array(32).fill(0xa1);
  const inv = new Uint8Array(32).fill(0xb2);
  ctx.currentContractIndex = 28;
  ctx.stackIndex = -1;
  ctx.currentContractId = 28n;
  ctx.originator = orig;
  ctx.invocator = inv;
  ctx.invocationReward = 1234567890n;
  ctx.entryPoint = 11;

  // read back through a fresh view over the same bytes
  const r = QpiContext.wrap(ctx.bytes);
  expect(r.currentContractIndex).toBe(28);
  expect(r.stackIndex).toBe(-1);
  expect(r.currentContractId).toBe(28n);
  expect([...r.originator]).toEqual([...orig]);
  expect([...r.invocator]).toEqual([...inv]);
  expect(r.invocationReward).toBe(1234567890n);
  expect(r.entryPoint).toBe(11);
});

test("Asset / AssetSelect match the qpi.h selector layout", () => {
  expect(Asset.SIZE).toBe(40);
  expect(Asset.OFFSETS).toEqual({ issuer: 0, assetName: 32 });

  expect(AssetSelect.SIZE).toBe(36);
  expect(AssetSelect.OFFSETS).toEqual({ id: 0, mgmt: 32, anyId: 34, anyMgmt: 35 });
});

test("PreManagementRightsTransfer input/output match the share-rights callback ABI", () => {
  expect(PreManagementRightsTransferInput.SIZE).toBe(128);
  expect(PreManagementRightsTransferInput.OFFSETS).toMatchObject({
    asset: 0,
    owner: 40,
    possessor: 72,
    shares: 104,
    offeredFee: 112,
    otherContractIndex: 120,
  });

  expect(PreManagementRightsTransferOutput.SIZE).toBe(16);
  expect(PreManagementRightsTransferOutput.OFFSETS).toEqual({ allowTransfer: 0, requestedFee: 8 });

  // the embedded Asset writes through to the parent buffer
  const req = PreManagementRightsTransferInput.alloc();
  req.asset.issuer = new Uint8Array(32).fill(7);
  req.asset.assetName = 0x4e454b4f54n; // "TOKEN"
  req.otherContractIndex = 4;
  expect(req.bytes[0]).toBe(7);
  expect(Asset.wrap(req.bytes).assetName).toBe(0x4e454b4f54n);
  expect(new DataView(req.bytes.buffer).getUint16(120, true)).toBe(4);
});

test("PostIncomingTransferInput is the 48-byte transfer notification", () => {
  expect(PostIncomingTransferInput.SIZE).toBe(48);
  expect(PostIncomingTransferInput.OFFSETS).toEqual({ source: 0, amount: 32, type: 40 });
});

test("ContractId is id(slot,0,0,0): slot in lane0, upper lanes zero", () => {
  expect(ContractId.SIZE).toBe(32);
  expect(ContractId.OFFSETS).toEqual({ lane0: 0, lane1: 8, lane2: 16, lane3: 24 });

  const id = ContractId.alloc();
  id.lane0 = 28n;
  expect(id.bytes.length).toBe(32);
  expect(new DataView(id.bytes.buffer).getBigUint64(0, true)).toBe(28n);
  // a regular entity (non-zero upper lane) is distinguishable from a contract id
  const entity = ContractId.alloc();
  entity.lane0 = 28n;
  entity.lane1 = 99n;
  expect(entity.lane1 !== 0n).toBe(true);
});
