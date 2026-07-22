// Zero-copy views over contract-execution ABI buffers.
// Mirrors core-lite's qpi.h context and system-procedure layouts.
import { defineStruct, blob, u8, u16, u32, i32, i64, u64, pad, sub } from "@qinit/core";

// ---- QpiContext (qpi.h): the 256-byte per-call header a contract reads for its identity + the caller chain.
// Only the fields the host populates are named; the reserved gaps are explicit pads. ----
export const QpiContext = defineStruct("QpiContext", {
  currentContractIndex: u32, // @0  this contract's slot
  stackIndex: i32, // @4  call-stack depth (host writes -1)
  currentContractId: u64, // @8  id(slot,0,0,0) low lane
  _reserved0: pad(24), // @16 unused QpiContext words
  originator: blob(32), // @40 root initiator of the call chain
  invocator: blob(32), // @72 direct caller (tx source / calling contract)
  invocationReward: i64, // @104 qu attached to this invocation
  entryPoint: u8, // @112 system-proc id, or USER_PROCEDURE/USER_FUNCTION
  _reserved1: pad(143), // @113 pad out to the full 256-byte header
});
export type QpiContext = InstanceType<typeof QpiContext>;

// ---- Asset (qpi.h): the 40-byte {issuer, assetName} pair that keys an asset. ----
export const Asset = defineStruct("Asset", {
  issuer: blob(32), // @0
  assetName: u64, // @32
});
export type Asset = InstanceType<typeof Asset>;

// ---- AssetOwnershipSelect / AssetPossessionSelect (qpi.h): a 36-byte holding selector — an id plus a managing
// contract index and "any" wildcards. The ownership and possession selects share this layout. ----
export const AssetSelect = defineStruct("AssetSelect", {
  id: blob(32), // @0  owner / possessor id (ignored when anyId)
  mgmt: u16, // @32 managing contract index (ignored when anyMgmt)
  anyId: u8, // @34 match any id
  anyMgmt: u8, // @35 match any managing contract
});
export type AssetSelect = InstanceType<typeof AssetSelect>;

// ---- PreManagementRightsTransfer_input (qpi.h): the 128-byte request handed to a managing contract's
// PRE/POST_RELEASE/ACQUIRE_SHARES callback. ----
export const PreManagementRightsTransferInput = defineStruct("PreManagementRightsTransferInput", {
  asset: sub(Asset), // @0  issuer + assetName
  owner: blob(32), // @40
  possessor: blob(32), // @72
  shares: i64, // @104
  offeredFee: i64, // @112
  otherContractIndex: u16, // @120 the counterpart contract index
});
export type PreManagementRightsTransferInput = InstanceType<
  typeof PreManagementRightsTransferInput
>;

// ---- PreManagementRightsTransfer_output (qpi.h): the 16-byte reply (bool allow padded to the sint64 fee). ----
export const PreManagementRightsTransferOutput = defineStruct("PreManagementRightsTransferOutput", {
  allowTransfer: u8, // @0
  requestedFee: i64, // @8  (natural pad after the bool)
});
export type PreManagementRightsTransferOutput = InstanceType<
  typeof PreManagementRightsTransferOutput
>;

// ---- PostIncomingTransfer_input (qpi.h): the 48-byte notification the system fires into a contract's
// POST_INCOMING_TRANSFER callback after it receives qu. ----
export const PostIncomingTransferInput = defineStruct("PostIncomingTransferInput", {
  source: blob(32), // @0
  amount: i64, // @32
  type: u8, // @40 transfer type (standard / procedure / qpi / by-other-contract)
});
export type PostIncomingTransferInput = InstanceType<typeof PostIncomingTransferInput>;

// ---- ContractId (m256.h): a contract's id is id(slot,0,0,0) — the slot in lane 0, lanes 1-3 zero. Used to build
// a contract's spectrum id and to recognise one (an id with non-zero upper lanes is a regular entity). ----
export const ContractId = defineStruct("ContractId", {
  lane0: u64, // @0  slot
  lane1: u64, // @8
  lane2: u64, // @16
  lane3: u64, // @24
});
export type ContractId = InstanceType<typeof ContractId>;
