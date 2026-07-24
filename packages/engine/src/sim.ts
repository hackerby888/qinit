import type { DebugTrace } from "@qinit/core";
import { Contract, Entity, HostServices, KIND, SP } from "./runtime";
import { toHex, verifySync } from "./k12";
import { TraceRecorder } from "./trace";
import { Committee, type CommitteeOpts } from "./consensus";
import { FeeManager, type FeeMode } from "./fees";
import { SpectrumLedger } from "./spectrum";
import { OracleManager } from "./oracle";
import { AssetLedger, packAssetName, type AssetSnapshot } from "./assets";
import { TickConsensus, type TickRecord } from "./ticking";
import type { TickData } from "./wire";
import {
  PreManagementRightsTransferInput,
  PreManagementRightsTransferOutput,
  PostIncomingTransferInput,
  ContractId,
} from "./abi";
import { TxPool, type TxRecord } from "./txs";
import { ContractRegistry, K12_MAX_LEAF_BYTES } from "./registry";
import type { LogSink, LogLevel } from "./log";
import type { NativeLogger } from "./native-logger";
import {
  LOG_SC_BEGIN_EPOCH,
  LOG_SC_BEGIN_TICK,
  LOG_SC_END_EPOCH,
  LOG_SC_END_TICK,
  LOG_SC_INITIALIZE,
} from "./native-logger";

export type { AssetSnapshot };
export type { FeeMode } from "./fees";
export type { TickRecord } from "./ticking";
export type { TxRecord } from "./txs";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h
const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)
const EP_USER_PROCEDURE = 11; // contract_def.h USER_PROCEDURE_CALL (contractSystemProcedureCount=10, +1)
const EP_USER_PROCEDURE_NOTIFICATION = 16;
const ZERO32 = new Uint8Array(32);
const IPO_SHARE_COUNT = 676; // NUMBER_OF_COMPUTORS — a contract's IPO shares: one per computor (0..675)
const IPO_SHARE_PRICE = 1000000n; // default IPO price per share (Qu)

const TT_STANDARD = 0;
const TT_PROCEDURE = 1;
const TT_QPI = 2;
const TT_DIVIDENDS = 3; // qpiDistributeDividends
const TT_PROCEDURE_BY_OTHER_CONTRACT = 6;

const EP_USER_FUNCTION = 12; // contract_def.h USER_FUNCTION_CALL (contractSystemProcedureCount=10, +2)
const MAX_CALL_DEPTH = 10; // NUMBER_OF_CONTRACT_EXECUTION_BUFFERS (recursion-depth guard)
const EMPTY = new Uint8Array(0);

const CALL_ERR_NONE = 0;
const CALL_ERR_INSUFFICIENT_FEES = 2;
const CALL_ERR_ALLOC = 3;
const CALL_ERR_INACTIVE = 4;

const CONTRACT_COUNT = 1024;

const INVALID_PROPOSAL_INDEX = 0xffff;

export interface ProcedureOpts {
  invocator?: Uint8Array;
  originator?: Uint8Array;
  reward?: bigint;
}

export class Sim {
  tickN = 0;
  epochN = 0;
  epochLength = 3000;
  host: HostServices;
  onLog?: LogSink;
  private registry: ContractRegistry;
  private spectrum = new SpectrumLedger();
  private oracle: OracleManager;
  private pitDepth = 0;
  private assets = new AssetLedger({
    contractId: (slot) => this.contractId(slot),
  });
  private txpool = new TxPool();
  private tickTxCount = 0;
  private callDepth = 0;
  private recorder = new TraceRecorder();
  private ticking: TickConsensus;
  tickDuration = 50;
  timeBaseMs = Date.UTC(2024, 0, 1);
  private mempoolMode: boolean;
  private fees: FeeManager;
  private nativeLogger?: NativeLogger;
  private computorOverride = new Map<number, Uint8Array>();
  prevSpectrumDigestOverride?: Uint8Array;

  constructor(
    options: {
      consensus?: CommitteeOpts;
      mempool?: boolean;
      fees?: FeeMode;
      defaultReserve?: bigint;
      liteTicking?: boolean;
      nativeLogger?: NativeLogger;
    } = {},
  ) {
    this.mempoolMode = options.mempool ?? false;
    this.fees = new FeeManager(
      options.fees ?? "off",
      options.defaultReserve,
    );
    this.nativeLogger = options.nativeLogger;
    this.registry = new ContractRegistry(this.fees, this.recorder);
    this.ticking = new TickConsensus(
      {
        spectrumDigest: () => this.spectrumDigest(),
        universeDigest: () => this.universeDigest(),
        computerDigest: () => this.computerDigest(),
        tickTransactionDigests: (tick) =>
          this.tickTransactions(tick).map((record) => record.digest),
        nowMs: () => this.nowMs(),
        tick: () => this.tickN,
        epoch: () => this.epochN,
      },
      options.consensus ?? {},
      options.liteTicking ?? false,
    );

    this.oracle = new OracleManager({
      contractBalance: (slot) => this.balance(this.contractId(slot)),
      debitContract: (slot, amount) =>
        this.debit(this.contractId(slot), amount),
      notify: (slot, procId, input) => {
        const contract = this.contracts.get(slot)!;
        this.registry.fire(contract, KIND.PROCEDURE, procId, input, {
          invocator: ZERO32,
          originator: ZERO32,
          invocationReward: 0n,
          entryPoint: EP_USER_PROCEDURE_NOTIFICATION,
        });
      },
      nowMs: () => this.nowMs(),
    });
    this.host = {
      tick: () => this.tickN,
      epoch: () => this.epochN,
      nowMs: () => this.nowMs(),
      numberOfTickTransactions: () => this.tickTxCount,
      markDirty: (slot) => this.dirty.add(slot),
      log: (slot, level, msg) => {
        this.recorder.log(level, msg);
        this.nativeLogger?.log(slot, level, msg, this.epochN);
      },
      pauseLog: () => this.nativeLogger?.pause(),
      resumeLog: () => this.nativeLogger?.resume(),
      transfer: (slot, dest, amount, type) => this.doTransfer(slot, dest, amount, type),
      burn: (slot, amount, burnedFor) => this.doBurn(slot, amount, burnedFor),
      getEntity: (id) => this.entityOf(id),
      queryFeeReserve: (callerSlot, contractIndex) =>
        this.fees.queryFeeReserve(callerSlot, contractIndex),
      issueAsset: (slot, name, issuer, decimals, shares, unit, invocator) =>
        this.assets.issueAsset(
          slot,
          name,
          issuer,
          decimals,
          shares,
          unit,
          invocator,
        ),
      isAssetIssued: (issuer, name) =>
        this.assets.isAssetIssued(issuer, name) ? 1 : 0,
      numberOfShares: (asset, ownership, possession) =>
        this.assets.numberOfShares(asset, ownership, possession),
      numberOfPossessedShares: (
        name,
        issuer,
        owner,
        possessor,
        ownershipManager,
        possessionManager,
      ) =>
        this.assets.numberOfPossessedShares(
          name,
          issuer,
          owner,
          possessor,
          ownershipManager,
          possessionManager,
        ),
      assetEnumerate: (asset, ownership, possession, kind) =>
        this.assets.enumerate(asset, ownership, possession, kind),
      transferShares: (
        slot,
        name,
        issuer,
        owner,
        possessor,
        shares,
        newOwner,
      ) =>
        this.assets.transferShareOwnershipAndPossession(
          slot,
          name,
          issuer,
          owner,
          possessor,
          shares,
          newOwner,
        ),
      acquireShares: (
        slot,
        name,
        issuer,
        owner,
        possessor,
        shares,
        sourceOwnershipManager,
        sourcePossessionManager,
        fee,
      ) =>
        this.acquireShares(
          slot,
          name,
          issuer,
          owner,
          possessor,
          shares,
          sourceOwnershipManager,
          sourcePossessionManager,
          fee,
        ),
      releaseShares: (
        slot,
        name,
        issuer,
        owner,
        possessor,
        shares,
        destinationOwnershipManager,
        destinationPossessionManager,
        fee,
      ) =>
        this.releaseShares(
          slot,
          name,
          issuer,
          owner,
          possessor,
          shares,
          destinationOwnershipManager,
          destinationPossessionManager,
          fee,
        ),
      dayOfWeek: (year, month, day) =>
        (new Date(Date.UTC(2000 + year, month - 1, day)).getUTCDay() + 4) %
        7,
      signatureValidity: (entity, digest, signature) =>
        verifySync(entity, digest, signature) ? 1 : 0,
      bidInIPO: () => -1n,
      ipoBidId: (_contractIndex, index) =>
        index >= 0 && index < IPO_SHARE_COUNT
          ? this.ticking.getCommittee().computors[
              index % this.ticking.committeeSize()
            ].publicKey
          : ZERO32,
      ipoBidPrice: (_contractIndex, index) =>
        index >= 0 && index < IPO_SHARE_COUNT ? IPO_SHARE_PRICE : -3n,
      computeMiningFunction: () => ZERO32,
      initMiningSeed: () => {},
      getOracleQueryStatus: (queryId) => this.oracle.queryStatus(queryId),
      unsubscribeOracle: (slot, subscriptionId) =>
        this.oracle.unsubscribe(slot, subscriptionId),
      queryOracle: (
        slot,
        interfaceIndex,
        query,
        replySize,
        procedureId,
        timeout,
        fee,
      ) =>
        this.oracle.query(
          slot,
          interfaceIndex,
          query,
          replySize,
          procedureId,
          timeout,
          fee,
        ),
      subscribeOracle: (
        slot,
        interfaceIndex,
        query,
        replySize,
        timestampOffset,
        procedureId,
        period,
        notifyPrevious,
        fee,
      ) =>
        this.oracle.subscribe(
          slot,
          interfaceIndex,
          query,
          replySize,
          timestampOffset,
          procedureId,
          period,
          notifyPrevious,
          fee,
        ),
      getOracleQuery: (queryId) => this.oracle.getQuery(queryId),
      getOracleReply: (queryId) => this.oracle.getReply(queryId),
      isContractId: (id) => (this.contractSlotOf(id) >= 0 ? 1 : 0),
      arbitrator: () => this.ticking.getCommittee().arbitrator.publicKey,
      computor: (index) =>
        this.computorOverride.get(index >>> 0) ??
        this.ticking.getCommittee().computors[
          index % this.ticking.committeeSize()
        ]?.publicKey ??
        ZERO32,
      prevSpectrumDigest: () =>
        this.prevSpectrumDigestOverride ?? this.ticking.prevSpectrumDigest(),
      prevUniverseDigest: () => this.ticking.prevUniverseDigest(),
      prevComputerDigest: () => this.ticking.prevComputerDigest(),
      distributeDividends: (slot, amountPerShare) =>
        this.doDistributeDividends(slot, amountPerShare),
      callFunction: (
        callerSlot,
        calleeIndex,
        inputType,
        input,
        originator,
      ) =>
        this.doCallFunction(
          callerSlot,
          calleeIndex,
          inputType,
          input,
          originator,
        ),
      invokeProcedure: (
        callerSlot,
        calleeIndex,
        inputType,
        input,
        reward,
        originator,
      ) =>
        this.doInvokeProcedure(
          callerSlot,
          calleeIndex,
          inputType,
          input,
          reward,
          originator,
        ),
      nextId: (id) => this.nextId(id),
      prevId: (id) => this.prevId(id),
      setShareholderProposal: (
        callerSlot,
        calleeIndex,
        proposal,
        reward,
        originator,
      ) =>
        this.doSetShareholderProposal(
          callerSlot,
          calleeIndex,
          proposal,
          reward,
          originator,
        ),
      setShareholderVotes: (
        callerSlot,
        calleeIndex,
        vote,
        reward,
        originator,
      ) =>
        this.doSetShareholderVotes(
          callerSlot,
          calleeIndex,
          vote,
          reward,
          originator,
        ),
    };
  }

  feeReserveOf(slot: number): bigint {
    return this.fees.getReserve(slot);
  }

  setFeeReserve(slot: number, amount: bigint): void {
    this.fees.setReserve(slot, amount);
  }

  ipo(slot: number, finalPrice: bigint): void {
    this.fees.ipo(slot, finalPrice);
  }

  get contracts(): Map<number, Contract> {
    return this.registry.contracts;
  }

  get dirty(): Set<number> {
    return this.registry.dirty;
  }

  contractId(slot: number): Uint8Array {
    const id = ContractId.alloc();
    id.lane0 = BigInt(slot);
    return id.bytes;
  }

  private key(id: Uint8Array): string {
    return toHex(id.subarray(0, 32));
  }

  entityOf(id: Uint8Array): Entity | null {
    return this.spectrum.entityOf(id);
  }

  balance(id: Uint8Array): bigint {
    return this.spectrum.energy(id);
  }

  balanceOf(slot: number): bigint {
    return this.balance(this.contractId(slot));
  }

  credit(id: Uint8Array, amount: bigint, tick = this.tickN): void {
    this.spectrum.increaseEnergy(id, amount, tick);
  }

  debit(id: Uint8Array, amount: bigint, tick = this.tickN): void {
    this.spectrum.decreaseEnergy(id, amount, tick);
  }

  fund(id: Uint8Array, amount: bigint): void {
    this.spectrum.increaseEnergy(id, amount, this.tickN);
  }

  notifyIncomingTransfer(
    source: Uint8Array,
    destination: Uint8Array,
    amount: bigint,
    type: number,
  ): void {
    this.spectrum.decreaseEnergy(source, amount, this.tickN);
    this.spectrum.increaseEnergy(destination, amount, this.tickN);
    this.notifyPIT(destination, source, amount, type);
  }

  setComputorKey(index: number, key: Uint8Array): void {
    if (key.every((byte) => byte === 0)) {
      this.computorOverride.delete(index >>> 0);
    } else {
      this.computorOverride.set(index >>> 0, key.slice(0, 32));
    }
  }

  resetLedger(): void {
    this.spectrum = new SpectrumLedger();
    this.assets = new AssetLedger({
      contractId: (slot) => this.contractId(slot),
    });
  }

  nextId(id: Uint8Array): Uint8Array {
    return this.spectrum.nextId(id);
  }

  prevId(id: Uint8Array): Uint8Array {
    return this.spectrum.prevId(id);
  }

  private contractSlotOf(id: Uint8Array): number {
    const contractId = ContractId.wrap(id);
    if (
      contractId.lane1 !== 0n ||
      contractId.lane2 !== 0n ||
      contractId.lane3 !== 0n
    ) {
      return -1;
    }

    const slot = Number(contractId.lane0);
    return this.contracts.has(slot) ? slot : -1;
  }

  private doTransfer(
    slot: number,
    destination: Uint8Array,
    amount: bigint,
    type: number,
  ): bigint {
    if (this.pitDepth > 0 && this.contractSlotOf(destination) >= 0) {
      return INVALID_AMOUNT;
    }
    if (amount < 0n || amount > MAX_AMOUNT) {
      return -(MAX_AMOUNT + 1n);
    }

    const source = this.contractId(slot);
    const remaining = this.balance(source) - amount;
    if (remaining < 0n) {
      return remaining;
    }

    this.debit(source, amount);
    this.credit(destination, amount);
    this.notifyPIT(destination, source, amount, type);

    return remaining;
  }

  private doBurn(slot: number, amount: bigint, burnedFor: number): bigint {
    if (amount < 0n || amount > MAX_AMOUNT) {
      return -(MAX_AMOUNT + 1n);
    }

    const target =
      burnedFor < 1 || burnedFor >= CONTRACT_COUNT ? slot : burnedFor;
    if (this.fees.metered && this.fees.isFailed(target)) {
      return -amount;
    }

    const source = this.contractId(slot);
    const remaining = this.balance(source) - amount;
    if (remaining < 0n) {
      return remaining;
    }

    this.debit(source, amount);
    if (this.fees.metered) {
      this.fees.add(target, amount);
    }

    return remaining;
  }

  private idEq(left: Uint8Array, right: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) {
      if (left[i] !== right[i]) {
        return false;
      }
    }

    return true;
  }

  transferShareManagementRights(
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    srcMgmt: number,
    dstMgmt: number,
    shares: bigint,
  ): boolean {
    return this.assets.transferShareManagementRights(
      name,
      issuer,
      owner,
      possessor,
      srcMgmt,
      dstMgmt,
      shares,
    );
  }

  private runManagementCallback(
    targetSlot: number,
    spId: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    fee: bigint,
    otherSlot: number,
  ): { allow: boolean; fee: bigint } {
    const contract = this.contracts.get(targetSlot);
    if (!contract || !contract.hasSysproc(spId)) {
      return { allow: false, fee: 0n };
    }

    const request = PreManagementRightsTransferInput.alloc();
    request.asset.issuer = issuer;
    request.asset.assetName = name;
    request.owner = owner;
    request.possessor = possessor;
    request.shares = shares;
    request.offeredFee = fee;
    request.otherContractIndex = otherSlot;

    const output = this.registry.fire(
      contract,
      KIND.SYSPROC,
      spId,
      request.bytes,
      { entryPoint: spId },
    );
    const reply = PreManagementRightsTransferOutput.wrap(output);
    const allow = output.length >= 1 && reply.allowTransfer !== 0;
    const requestedFee = output.length >= 16 ? reply.requestedFee : 0n;

    return { allow, fee: requestedFee };
  }

  acquireShares(
    callerSlot: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    sourceOwnershipManager: number,
    sourcePossessionManager: number,
    offeredFee: bigint,
  ): bigint {
    if (
      !this.idEq(owner, possessor) ||
      sourceOwnershipManager !== sourcePossessionManager
    ) {
      return INVALID_AMOUNT;
    }

    if (
      sourcePossessionManager === callerSlot ||
      sourcePossessionManager < 1 ||
      sourcePossessionManager >= CONTRACT_COUNT ||
      shares <= 0n ||
      offeredFee < 0n
    ) {
      return INVALID_AMOUNT;
    }

    const availableShares = this.assets.numberOfPossessedShares(
      name,
      issuer,
      owner,
      possessor,
      sourcePossessionManager,
      sourcePossessionManager,
    );
    if (availableShares < shares) {
      return INVALID_AMOUNT;
    }

    const callback = this.runManagementCallback(
      sourceOwnershipManager,
      SP.PRE_RELEASE_SHARES,
      name,
      issuer,
      owner,
      possessor,
      shares,
      offeredFee,
      callerSlot,
    );

    if (
      !callback.allow ||
      callback.fee < 0n ||
      callback.fee > MAX_AMOUNT
    ) {
      return INVALID_AMOUNT;
    }

    if (callback.fee > offeredFee) {
      return -callback.fee;
    }

    if (callback.fee > 0n) {
      const feeResult = this.doTransfer(
        callerSlot,
        this.contractId(sourceOwnershipManager),
        callback.fee,
        TT_QPI,
      );
      if (feeResult < 0n) {
        return -callback.fee;
      }
    }

    if (
      !this.transferShareManagementRights(
        name,
        issuer,
        owner,
        possessor,
        sourcePossessionManager,
        callerSlot,
        shares,
      )
    ) {
      return INVALID_AMOUNT;
    }

    this.runManagementCallback(
      sourceOwnershipManager,
      SP.POST_RELEASE_SHARES,
      name,
      issuer,
      owner,
      possessor,
      shares,
      callback.fee,
      callerSlot,
    );

    return callback.fee;
  }

  releaseShares(
    callerSlot: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    destinationOwnershipManager: number,
    destinationPossessionManager: number,
    offeredFee: bigint,
  ): bigint {
    if (
      !this.idEq(owner, possessor) ||
      destinationOwnershipManager !== destinationPossessionManager
    ) {
      return INVALID_AMOUNT;
    }

    if (
      destinationPossessionManager === callerSlot ||
      destinationPossessionManager < 1 ||
      destinationPossessionManager >= CONTRACT_COUNT ||
      shares <= 0n ||
      offeredFee < 0n
    ) {
      return INVALID_AMOUNT;
    }

    const availableShares = this.assets.numberOfPossessedShares(
      name,
      issuer,
      owner,
      possessor,
      callerSlot,
      callerSlot,
    );
    if (availableShares < shares) {
      return INVALID_AMOUNT;
    }

    const callback = this.runManagementCallback(
      destinationOwnershipManager,
      SP.PRE_ACQUIRE_SHARES,
      name,
      issuer,
      owner,
      possessor,
      shares,
      offeredFee,
      callerSlot,
    );

    if (
      !callback.allow ||
      callback.fee < 0n ||
      callback.fee > MAX_AMOUNT
    ) {
      return INVALID_AMOUNT;
    }

    if (callback.fee > offeredFee) {
      return -callback.fee;
    }

    if (callback.fee > 0n) {
      const feeResult = this.doTransfer(
        callerSlot,
        this.contractId(destinationOwnershipManager),
        callback.fee,
        TT_QPI,
      );
      if (feeResult < 0n) {
        return -callback.fee;
      }
    }

    if (
      !this.transferShareManagementRights(
        name,
        issuer,
        owner,
        possessor,
        callerSlot,
        destinationPossessionManager,
        shares,
      )
    ) {
      return INVALID_AMOUNT;
    }

    this.runManagementCallback(
      destinationOwnershipManager,
      SP.POST_ACQUIRE_SHARES,
      name,
      issuer,
      owner,
      possessor,
      shares,
      callback.fee,
      callerSlot,
    );

    return callback.fee;
  }

  private doDistributeDividends(slot: number, amountPerShare: bigint): number {
    if (this.pitDepth > 0) {
      return 0;
    }

    if (amountPerShare < 0n) {
      return 0;
    }

    const total = amountPerShare * BigInt(IPO_SHARE_COUNT);
    if (total > MAX_AMOUNT) {
      return 0;
    }

    const contractId = this.contractId(slot);
    if (this.balance(contractId) < total) {
      return 0;
    }

    this.debit(contractId, total);
    if (amountPerShare === 0n) {
      return 1;
    }

    const name = this.contractAssetNames.get(slot);
    if (name === undefined) {
      return 1;
    }

    for (const possession of this.assets.possessionsOf(ZERO32, name)) {
      if (possession.shares === 0n) {
        continue;
      }

      const dividend = amountPerShare * possession.shares;
      this.credit(possession.possessor, dividend);
      this.notifyPIT(
        possession.possessor,
        contractId,
        dividend,
        TT_DIVIDENDS,
      );
    }

    return 1;
  }

  private contractAssetNames = new Map<number, bigint>();

  setContractAssetName(slot: number, name: bigint | string): void {
    this.contractAssetNames.set(
      slot,
      typeof name === "string" ? packAssetName(name) : name & 0xffffffffffffffn,
    );
  }

  mintDeployShares(
    slot: number,
    name: bigint | string,
    holder: Uint8Array,
  ): void {
    const packedName =
      typeof name === "string"
        ? packAssetName(name)
        : name & 0xffffffffffffffn;
    this.setContractAssetName(slot, packedName);

    if (this.assets.isAssetIssued(ZERO32, packedName)) {
      return;
    }

    this.assets.mintContractShares(
      1,
      packedName,
      BigInt(IPO_SHARE_COUNT),
    );
    this.assets.transferShareOwnershipAndPossession(
      1,
      packedName,
      ZERO32,
      ZERO32,
      ZERO32,
      BigInt(IPO_SHARE_COUNT),
      holder,
    );
  }

  assetUniverse(): AssetSnapshot[] {
    return this.assets.assetUniverse();
  }

  private notifyPIT(
    destination: Uint8Array,
    source: Uint8Array,
    amount: bigint,
    type: number,
  ): void {
    const slot = this.contractSlotOf(destination);
    if (slot < 0) {
      return;
    }

    const contract = this.contracts.get(slot)!;
    if (!contract.hasSysproc(SP.POST_INCOMING_TRANSFER)) {
      return;
    }

    const notice = PostIncomingTransferInput.alloc();
    notice.source = source;
    notice.amount = amount;
    notice.type = type;
    const input = notice.bytes;

    this.pitDepth++;
    try {
      this.registry.fire(
        contract,
        KIND.SYSPROC,
        SP.POST_INCOMING_TRANSFER,
        input,
        {
          entryPoint: SP.POST_INCOMING_TRANSFER,
        },
      );
    } finally {
      this.pitDepth--;
    }
  }

  deploy(
    slot: number,
    wasm: Uint8Array,
    externalMemory?: WebAssembly.Memory,
  ): Contract {
    this.nativeLogger?.begin(this.tickN, LOG_SC_INITIALIZE);
    let contract: Contract;

    try {
      contract = this.registry.deploy(
        slot,
        wasm,
        this.host,
        externalMemory,
      );
    } finally {
      this.nativeLogger?.end();
    }

    this.emit(
      "info",
      "deploy",
      `slot ${slot} deployed · ${(wasm.length / 1024) | 0}KB wasm`,
    );
    if (contract.stateSize > K12_MAX_LEAF_BYTES) {
      this.emit(
        "warn",
        "digest",
        `slot ${slot} state ${(contract.stateSize / 1048576) | 0}MB > ${K12_MAX_LEAF_BYTES / 1048576}MB — excluded from computer digest (zero leaf)`,
      );
    }

    return contract;
  }

  deployWithImports(
    slot: number,
    wasm: Uint8Array,
    imports: WebAssembly.Imports,
  ): Contract {
    this.nativeLogger?.begin(this.tickN, LOG_SC_INITIALIZE);
    try {
      return this.registry.deploy(slot, wasm, this.host, undefined, imports);
    } finally {
      this.nativeLogger?.end();
    }
  }

  undeploy(slot: number): boolean {
    const removed = this.registry.undeploy(slot);
    if (removed) {
      this.emit("info", "deploy", `slot ${slot} undeployed`);
    }

    return removed;
  }

  setDebug(on: boolean): void {
    this.recorder.setEnabled(on);
  }

  getTrace(): DebugTrace {
    return this.recorder.trace();
  }

  private emit(level: LogLevel, category: string, message: string): void {
    this.onLog?.({
      level,
      tick: this.tickN,
      cat: category,
      msg: message,
    });
  }

  beginEpoch(): void {
    this.oracle.beginEpoch();
    this.nativeLogger?.begin(this.tickN, LOG_SC_BEGIN_EPOCH);

    try {
      for (const slot of this.registry.slots(true)) {
        const contract = this.contracts.get(slot)!;
        if (contract.hasSysproc(SP.BEGIN_EPOCH)) {
          this.registry.fire(
            contract,
            KIND.SYSPROC,
            SP.BEGIN_EPOCH,
            new Uint8Array(0),
            {
              entryPoint: SP.BEGIN_EPOCH,
            },
          );
        }
      }
    } finally {
      this.nativeLogger?.end();
    }
  }

  endEpoch(): void {
    this.nativeLogger?.begin(this.tickN, LOG_SC_END_EPOCH);

    try {
      for (const slot of this.registry.slots(false)) {
        const contract = this.contracts.get(slot)!;
        if (contract.hasSysproc(SP.END_EPOCH)) {
          this.registry.fire(
            contract,
            KIND.SYSPROC,
            SP.END_EPOCH,
            new Uint8Array(0),
            {
              entryPoint: SP.END_EPOCH,
            },
          );
        }
      }
    } finally {
      this.nativeLogger?.end();
    }
  }

  beginTick(): void {
    this.tickN++;
    this.tickTxCount = this.txpool.dueCount(this.tickN);
    this.emit(
      "debug",
      "tick",
      `tick ${this.tickN} begin · ${this.tickTxCount} tx`,
    );

    this.nativeLogger?.begin(this.tickN, LOG_SC_BEGIN_TICK);
    try {
      for (const slot of this.registry.slots(true)) {
        const contract = this.contracts.get(slot)!;
        if (
          contract.hasSysproc(SP.BEGIN_TICK) &&
          this.fees.reserveOk(slot)
        ) {
          this.registry.fire(
            contract,
            KIND.SYSPROC,
            SP.BEGIN_TICK,
            new Uint8Array(0),
            {
              entryPoint: SP.BEGIN_TICK,
            },
          );
        }
      }
    } finally {
      this.nativeLogger?.end();
    }
  }

  endTick(): void {
    this.nativeLogger?.begin(this.tickN, LOG_SC_END_TICK);

    try {
      for (const slot of this.registry.slots(false)) {
        const contract = this.contracts.get(slot)!;
        if (
          contract.hasSysproc(SP.END_TICK) &&
          this.fees.reserveOk(slot)
        ) {
          this.registry.fire(
            contract,
            KIND.SYSPROC,
            SP.END_TICK,
            new Uint8Array(0),
            {
              entryPoint: SP.END_TICK,
            },
          );
        }
      }
    } finally {
      this.nativeLogger?.end();
    }

    this.emit("debug", "tick", `tick ${this.tickN} end`);
  }

  advance(): void {
    const nextTick = this.tickN + 1;

    if (this.epochLength > 0 && nextTick % this.epochLength === 0) {
      this.endEpoch();
      this.epochN++;
      this.beginEpoch();
      this.emit(
        "info",
        "epoch",
        `epoch ${this.epochN - 1} → ${this.epochN}`,
      );
    }

    this.beginTick();
    this.drainMempool();
    this.oracle.pump();
    this.endTick();
    this.ticking.finalizeTick();
    this.nativeLogger?.finalizeTick(this.tickN);
  }

  query(slot: number, it: number, input?: Uint8Array): Uint8Array {
    return this.contracts.get(slot)!.invoke(KIND.FUNCTION, it, input);
  }

  private runProcedure(
    slot: number,
    it: number,
    input: Uint8Array,
    invocator: Uint8Array,
    originator: Uint8Array,
    reward: bigint,
    transferType = TT_PROCEDURE,
  ): Uint8Array {
    const contract = this.contracts.get(slot)!;
    if (reward > 0n) {
      this.notifyPIT(
        this.contractId(slot),
        invocator,
        reward,
        transferType,
      );
    }

    return this.registry.fire(contract, KIND.PROCEDURE, it, input, {
      invocator,
      originator,
      invocationReward: reward,
      entryPoint: EP_USER_PROCEDURE,
    });
  }

  resolveOracle(queryId: bigint, reply: Uint8Array, status?: number): boolean {
    return status === undefined
      ? this.oracle.resolve(queryId, reply)
      : this.oracle.resolve(queryId, reply, status);
  }

  pendingOracleQueries(): {
    queryId: bigint;
    slot: number;
    interfaceIndex: number;
    query: Uint8Array;
  }[] {
    return this.oracle.pending();
  }

  setOracleProvider(
    provider:
      | ((interfaceIndex: number, query: Uint8Array) => Uint8Array | null)
      | null,
  ): void {
    this.oracle.setProvider(provider);
  }

  doCallFunction(
    callerSlot: number,
    calleeIndex: number,
    inputType: number,
    input: Uint8Array,
    originator: Uint8Array,
  ): { error: number; output: Uint8Array } {
    const callee = this.contracts.get(calleeIndex);
    if (!callee || calleeIndex >= callerSlot) {
      return { error: CALL_ERR_INACTIVE, output: EMPTY };
    }
    if (!this.fees.reserveOk(calleeIndex)) {
      return { error: CALL_ERR_INSUFFICIENT_FEES, output: EMPTY };
    }
    if (this.callDepth >= MAX_CALL_DEPTH) {
      return { error: CALL_ERR_ALLOC, output: EMPTY };
    }

    this.callDepth++;

    try {
      const invocator = this.contractId(callerSlot);
      const output = callee.invoke(KIND.FUNCTION, inputType, input, {
        invocator,
        originator,
        invocationReward: 0n,
        entryPoint: EP_USER_FUNCTION,
      });
      return { error: CALL_ERR_NONE, output };
    } finally {
      this.callDepth--;
    }
  }

  doInvokeProcedure(
    callerSlot: number,
    calleeIndex: number,
    inputType: number,
    input: Uint8Array,
    reward: bigint,
    originator: Uint8Array,
  ): { error: number; output: Uint8Array } {
    const callee = this.contracts.get(calleeIndex);
    if (!callee || calleeIndex >= callerSlot) {
      return { error: CALL_ERR_INACTIVE, output: EMPTY };
    }
    if (!this.fees.reserveOk(calleeIndex)) {
      return { error: CALL_ERR_INSUFFICIENT_FEES, output: EMPTY };
    }
    if (this.callDepth >= MAX_CALL_DEPTH) {
      return { error: CALL_ERR_ALLOC, output: EMPTY };
    }

    let transferredReward = reward;
    if (transferredReward > 0n) {
      const callerId = this.contractId(callerSlot);
      if (this.balance(callerId) >= transferredReward) {
        this.debit(callerId, transferredReward);
        this.credit(
          this.contractId(calleeIndex),
          transferredReward,
        );
      } else {
        transferredReward = 0n;
      }
    }

    this.callDepth++;

    try {
      const invocator = this.contractId(callerSlot);
      const output = this.runProcedure(
        calleeIndex,
        inputType,
        input,
        invocator,
        originator,
        transferredReward,
        TT_PROCEDURE_BY_OTHER_CONTRACT,
      );
      return { error: CALL_ERR_NONE, output };
    } finally {
      this.callDepth--;
    }
  }

  private transferReward(
    callerSlot: number,
    calleeIndex: number,
    reward: bigint,
  ): void {
    const callerId = this.contractId(callerSlot);
    if (this.balance(callerId) < reward) {
      return;
    }

    this.debit(callerId, reward);
    this.credit(this.contractId(calleeIndex), reward);
  }

  doSetShareholderProposal(
    callerSlot: number,
    calleeIndex: number,
    proposal: Uint8Array,
    reward: bigint,
    originator: Uint8Array,
  ): number {
    if (
      calleeIndex === callerSlot ||
      calleeIndex === 0 ||
      !this.contracts.has(calleeIndex) ||
      reward < 0n
    ) {
      return INVALID_PROPOSAL_INDEX;
    }
    if (this.callDepth >= MAX_CALL_DEPTH) {
      return INVALID_PROPOSAL_INDEX;
    }

    const callee = this.contracts.get(calleeIndex)!;
    if (
      !callee.hasSysproc(SP.SET_SHAREHOLDER_PROPOSAL) ||
      !this.fees.reserveOk(calleeIndex)
    ) {
      return INVALID_PROPOSAL_INDEX;
    }

    if (reward > 0n) {
      this.transferReward(callerSlot, calleeIndex, reward);
    }

    this.callDepth++;

    try {
      const output = this.registry.fire(
        callee,
        KIND.SYSPROC,
        SP.SET_SHAREHOLDER_PROPOSAL,
        proposal,
        {
          invocator: this.contractId(callerSlot),
          originator,
          entryPoint: SP.SET_SHAREHOLDER_PROPOSAL,
        },
      );

      return output.length >= 2
        ? new DataView(
            output.buffer,
            output.byteOffset,
            output.byteLength,
          ).getUint16(0, true)
        : 0;
    } finally {
      this.callDepth--;
    }
  }

  doSetShareholderVotes(
    callerSlot: number,
    calleeIndex: number,
    vote: Uint8Array,
    reward: bigint,
    originator: Uint8Array,
  ): number {
    if (
      calleeIndex === callerSlot ||
      calleeIndex === 0 ||
      !this.contracts.has(calleeIndex) ||
      reward < 0n
    ) {
      return 0;
    }
    if (this.callDepth >= MAX_CALL_DEPTH) {
      return 0;
    }

    const callee = this.contracts.get(calleeIndex)!;
    if (
      !callee.hasSysproc(SP.SET_SHAREHOLDER_VOTES) ||
      !this.fees.reserveOk(calleeIndex)
    ) {
      return 0;
    }

    if (reward > 0n) {
      this.transferReward(callerSlot, calleeIndex, reward);
    }

    this.callDepth++;

    try {
      const output = this.registry.fire(
        callee,
        KIND.SYSPROC,
        SP.SET_SHAREHOLDER_VOTES,
        vote,
        {
          invocator: this.contractId(callerSlot),
          originator,
          entryPoint: SP.SET_SHAREHOLDER_VOTES,
        },
      );

      return output.length >= 1 ? output[0] : 0;
    } finally {
      this.callDepth--;
    }
  }

  procedure(
    slot: number,
    inputType: number,
    input?: Uint8Array,
    options: ProcedureOpts = {},
  ): Uint8Array {
    const reward = options.reward ?? 0n;
    const invocator = options.invocator ?? ZERO32;
    const originator = options.originator ?? invocator;

    if (!this.fees.reserveOk(slot)) {
      return EMPTY;
    }

    if (reward > 0n) {
      this.credit(this.contractId(slot), reward);
    }

    return this.runProcedure(
      slot,
      inputType,
      input ?? new Uint8Array(0),
      invocator,
      originator,
      reward,
    );
  }

  applyTx(
    source: Uint8Array,
    destination: Uint8Array,
    amount: bigint,
    inputType: number,
    payload: Uint8Array,
    txId: string,
    digest: Uint8Array = ZERO32,
  ): { moneyFlew: boolean } {
    const tick = this.tickN;
    const txIndex = this.txpool.tickTransactions(tick).length;
    this.nativeLogger?.begin(tick, txIndex);
    try {
      let moneyFlew = false;

      if (amount > 0n && this.balance(source) >= amount) {
        this.debit(source, amount, tick);
        this.credit(destination, amount, tick);
        moneyFlew = true;
      }

      const reward = moneyFlew ? amount : 0n;

      const slot = this.contractSlotOf(destination);
      if (slot >= 0) {
        const contract = this.contracts.get(slot)!;
        const isProcedure = contract.entries.some(
          (entry) =>
            entry.kind === KIND.PROCEDURE &&
            entry.it === inputType,
        );

        if (isProcedure && !this.fees.reserveOk(slot)) {
          if (moneyFlew) {
            this.debit(destination, amount, tick);
            this.credit(source, amount, tick);
            moneyFlew = false;
          }

          this.emit(
            "warn",
            "fee",
            `slot ${slot} dormant — procedure it=${inputType} skipped${amount > 0n ? `, refunded ${amount}` : ""}`,
          );
        } else if (isProcedure) {
          const stateBefore = contract.state().slice();

          try {
            this.runProcedure(
              slot,
              inputType,
              payload,
              source,
              source,
              reward,
            );
          } catch (error) {
            contract.writeState(stateBefore);

            if (moneyFlew) {
              this.debit(destination, amount, tick);
              this.credit(source, amount, tick);
              moneyFlew = false;
            }

            const message = String(
              (error as Error)?.message ?? error,
            );
            this.emit(
              "warn",
              "tx",
              `slot ${slot} procedure it=${inputType} trapped: ${message}${amount > 0n ? `, refunded ${amount}` : ""}`,
            );
          }
        } else if (reward > 0n) {
          this.notifyPIT(
            destination,
            source,
            reward,
            TT_STANDARD,
          );
        }
      }

      this.emit(
        "info",
        "tx",
        `tx → ${slot >= 0 ? `slot ${slot}` : "user"} it=${inputType} amount=${amount} moneyFlew=${moneyFlew}`,
      );
      this.txpool.record({
        txId,
        tick,
        source: this.key(source),
        dest: this.key(destination),
        amount,
        inputType,
        moneyFlew,
        digest,
      });
      return { moneyFlew };
    } finally {
      this.nativeLogger?.end();
    }
  }

  // Queue future transactions in mempool mode; otherwise apply them immediately.
  enqueueTx(
    scheduledTick: number,
    source: Uint8Array,
    destination: Uint8Array,
    amount: bigint,
    inputType: number,
    payload: Uint8Array,
    txId: string,
    digest: Uint8Array = ZERO32,
  ): { moneyFlew: boolean; queued: boolean } {
    if (!this.mempoolMode || scheduledTick <= this.tickN) {
      const result = this.applyTx(
        source,
        destination,
        amount,
        inputType,
        payload,
        txId,
        digest,
      );

      return { moneyFlew: result.moneyFlew, queued: false };
    }

    this.txpool.queue(scheduledTick, {
      source,
      dest: destination,
      amount,
      inputType,
      payload,
      txId,
      digest,
    });

    return { moneyFlew: false, queued: true };
  }

  private drainMempool(): void {
    for (const transaction of this.txpool.takeDue(this.tickN)) {
      try {
        this.applyTx(
          transaction.source,
          transaction.dest,
          transaction.amount,
          transaction.inputType,
          transaction.payload,
          transaction.txId,
          transaction.digest,
        );
      } catch (error) {
        const message = String(
          (error as Error)?.message ?? error,
        );
        this.emit(
          "warn",
          "mempool",
          `tx ${transaction.txId} dropped: ${message}`,
        );
      }
    }
  }

  tickTransactions(tick: number): TxRecord[] {
    return this.txpool.tickTransactions(tick);
  }

  txByHash(txId: string): TxRecord | undefined {
    return this.txpool.txByHash(txId);
  }

  digest(slot: number): string {
    return this.registry.digest(slot);
  }

  getCommittee(): Committee {
    return this.ticking.getCommittee();
  }

  quorum(): number {
    return this.ticking.quorum();
  }

  nowMs(): number {
    return this.timeBaseMs + this.tickN * this.tickDuration;
  }

  entityCount(): number {
    return this.spectrum.size;
  }

  txCount(): number {
    return this.txpool.size;
  }

  computerDigest(): Uint8Array {
    return this.registry.computerDigest();
  }

  spectrumDigest(): Uint8Array {
    return this.spectrum.getSpectrumDigest();
  }

  universeDigest(): Uint8Array {
    return this.assets.getUniverseDigest();
  }

  universeProofOwned(ownerId: Uint8Array) {
    return this.assets.universeProofOwned(ownerId);
  }

  universeProofPossessed(possessorId: Uint8Array) {
    return this.assets.universeProofPossessed(possessorId);
  }

  spectrumProof(id: Uint8Array): {
    record: Uint8Array;
    index: number;
    siblings: Uint8Array[];
  } {
    return this.spectrum.spectrumProof(id);
  }

  tickRecord(tick: number): TickRecord | undefined {
    return this.ticking.tickRecord(tick);
  }

  tickData(tick: number): TickData | undefined {
    return this.ticking.tickData(tick);
  }

  alignedVotes(tick = this.tickN): number {
    return this.ticking.alignedVotes(tick);
  }

  signedComputorList(slotCount?: number): Uint8Array {
    return this.ticking.signedComputorList(slotCount);
  }
}
