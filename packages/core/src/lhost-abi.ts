/** Browser-safe description of the dynamic-contract host ABI. */
export type LhostValueType = "i32" | "i64";

export interface LhostFunctionSignature {
  readonly params: readonly LhostValueType[];
  readonly results: readonly LhostValueType[];
}

const signature = (
  params: readonly LhostValueType[] = [],
  results: readonly LhostValueType[] = [],
): LhostFunctionSignature => Object.freeze({
  params: Object.freeze([...params]),
  results: Object.freeze([...results]),
});

const I32 = "i32" as const;
const I64 = "i64" as const;

/** Exact names, order, and signatures registered by core-lite's canonical LHOST_TABLE. */
export const LHOST_ABI = Object.freeze({
  beginFn: signature([I32]),
  endFn: signature([I32]),
  markDirty: signature([I32]),
  pauseLog: signature(),
  resumeLog: signature(),
  acquireScratch: signature([I64, I32], [I32]),
  releaseScratch: signature([I32]),
  logBytes: signature([I32, I32, I32, I32]),
  k12: signature([I32, I32, I32]),
  transfer: signature([I32, I64], [I64]),
  transferTyped: signature([I32, I64, I32], [I64]),
  abort: signature([I32]),
  burn: signature([I64, I32], [I64]),
  epoch: signature([], [I32]),
  tick: signature([], [I32]),
  numberOfTickTransactions: signature([], [I32]),
  getEntity: signature([I32, I32], [I32]),
  queryFeeReserve: signature([I32], [I64]),
  nextId: signature([I32, I32]),
  prevId: signature([I32, I32]),
  isContractId: signature([I32], [I32]),
  arbitrator: signature([I32]),
  computor: signature([I32, I32]),
  day: signature([], [I32]),
  year: signature([], [I32]),
  hour: signature([], [I32]),
  minute: signature([], [I32]),
  month: signature([], [I32]),
  second: signature([], [I32]),
  millisecond: signature([], [I32]),
  now: signature([I32]),
  prevSpectrumDigest: signature([I32]),
  prevUniverseDigest: signature([I32]),
  prevComputerDigest: signature([I32]),
  isAssetIssued: signature([I32, I64], [I32]),
  issueAsset: signature([I64, I32, I32, I64, I64], [I64]),
  numberOfShares: signature([I32, I32, I32], [I64]),
  numberOfPossessedShares: signature([I64, I32, I32, I32, I32, I32], [I64]),
  assetEnumerate: signature([I32, I32, I32, I32, I32, I32], [I32]),
  transferShareOwnershipAndPossession: signature([I64, I32, I32, I32, I64, I32], [I64]),
  acquireShares: signature([I64, I32, I32, I32, I64, I32, I32, I64], [I64]),
  releaseShares: signature([I64, I32, I32, I32, I64, I32, I32, I64], [I64]),
  dayOfWeek: signature([I32, I32, I32], [I32]),
  signatureValidity: signature([I32, I32, I32], [I32]),
  bidInIPO: signature([I32, I64, I32], [I64]),
  ipoBidId: signature([I32, I32, I32]),
  ipoBidPrice: signature([I32, I32], [I64]),
  computeMiningFunction: signature([I32, I32, I32, I32]),
  initMiningSeed: signature([I32]),
  getOracleQueryStatus: signature([I64], [I32]),
  unsubscribeOracle: signature([I32], [I32]),
  queryOracle: signature([I32, I32, I32, I32, I32, I64], [I64]),
  subscribeOracle: signature([I32, I32, I32, I32, I32, I32, I64], [I32]),
  getOracleQuery: signature([I64, I32, I32], [I32]),
  getOracleReply: signature([I64, I32, I32], [I32]),
  distributeDividends: signature([I64], [I32]),
  liteCallFunction: signature([I32, I32, I32, I32, I32, I32], [I32]),
  liteInvokeProcedure: signature([I32, I32, I32, I32, I32, I32, I64], [I32]),
  liteSetShareholderProposal: signature([I32, I32, I64], [I32]),
  liteSetShareholderVotes: signature([I32, I32, I32, I64], [I32]),
} satisfies Readonly<Record<string, LhostFunctionSignature>>);

export type LhostImportName = keyof typeof LHOST_ABI;

/** Contract-visible record written by lhost.assetEnumerate. */
export const ASSET_ENUMERATION_RECORD = Object.freeze({
  size: 80,
  capacity: 1024,
  fields: Object.freeze({
    owner: Object.freeze({ offset: 0, size: 32 }),
    possessor: Object.freeze({ offset: 32, size: 32 }),
    shares: Object.freeze({ offset: 64, size: 8 }),
    ownershipManagingContract: Object.freeze({ offset: 72, size: 2 }),
    possessionManagingContract: Object.freeze({ offset: 74, size: 2 }),
  }),
});
