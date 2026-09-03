import { CHEAT_ERR, CONTRACT_ENTRY_POINTS, SYSTEM_PROCEDURES, type DebugTrace, type EngineFaultInfo } from "@qinit/core";
import { encodeBurningLog, encodeQuTransferLog, MAINNET_COMPUTOR_COUNT, MAX_INPUT_SIZE, QUBIC_LOG_TYPE, TXS_PER_TICK } from "@qinit/proto";
import { Contract, CONTRACT_ENTRY_KIND, ContractAbort, ContractExecutionError, Entity, HostServices } from "./contract/runtime";
import { toHex, verifySync } from "./support/k12";
import { TraceRecorder } from "./logging/trace";
import { Committee, MAX_NUMBER_OF_CONTRACTS, type CommitteeOpts } from "./chain/consensus";
import { FeeManager, type FeeMode } from "./contract/fees";
import { SpectrumLedger } from "./ledger/spectrum";
import { OracleManager } from "./chain/oracle";
import {
    AssetLedger,
    INVALID_AMOUNT,
    MAX_AMOUNT,
    packAssetName,
    type AssetIssuanceFilter,
    type AssetOwnershipFilter,
    type AssetPossessionFilter,
    type AssetSnapshot,
} from "./ledger/assets";
import { DEFAULT_TICK_HISTORY, TickConsensus, type TickRecord } from "./chain/ticking";
import type { TickData } from "./protocol/wire";
import { first32BytesEqual, type Id } from "./support/bytes";
import { PreManagementRightsTransferInput, PreManagementRightsTransferOutput, PostIncomingTransferInput, ContractId } from "./contract/abi";
import { TxPool, type TxRecord } from "./chain/txs";
import { ContractRegistry, K12_MAX_LEAF_BYTES } from "./contract/registry";
import type { LogSink, LogLevel } from "./logging/log";
import type { QubicLogStore } from "./logging/qubic-log-store";
import { LOG_SC_BEGIN_EPOCH, LOG_SC_BEGIN_TICK, LOG_SC_END_EPOCH, LOG_SC_END_TICK, LOG_SC_INITIALIZE, LOG_SC_NOTIFICATION } from "./logging/qubic-log-store";

export type { AssetSnapshot };
export type { FeeMode } from "./contract/fees";
export type { TickRecord } from "./chain/ticking";
export type { TxRecord } from "./chain/txs";

const EP_USER_PROCEDURE = CONTRACT_ENTRY_POINTS.userProcedure;
const EP_USER_PROCEDURE_NOTIFICATION = CONTRACT_ENTRY_POINTS.userProcedureNotification;
const ZERO32 = new Uint8Array(32);
const IPO_SHARE_COUNT = MAINNET_COMPUTOR_COUNT;
const IPO_SHARE_PRICE = 1000000n; // default IPO price per share (Qu)

const TRANSFER_TYPE_STANDARD_TRANSACTION = 0;
const TRANSFER_TYPE_PROCEDURE_TRANSACTION = 1;
const TRANSFER_TYPE_QPI_TRANSFER = 2;
const TRANSFER_TYPE_QPI_DISTRIBUTE_DIVIDENDS = 3;
const TRANSFER_TYPE_PROCEDURE_INVOCATION_BY_OTHER_CONTRACT = 6;

const EP_USER_FUNCTION = CONTRACT_ENTRY_POINTS.userFunction;
const NUMBER_OF_CONTRACT_EXECUTION_BUFFERS = 10; // recursion-depth guard
const EMPTY = new Uint8Array(0);

const NO_CALL_ERROR = 0;
const CALL_ERROR_INSUFFICIENT_FEES = 2;
const CALL_ERROR_ALLOCATION_FAILED = 3;
const CALL_ERROR_CONTRACT_INACTIVE = 4;

const INVALID_PROPOSAL_INDEX = 0xffff;

export interface ProcedureCallOptions {
    invocator?: Id;
    originator?: Id;
    reward?: bigint;
}

interface PendingOracleNotification {
    slot: number;
    procedureId: number;
    input: Uint8Array;
}

export class EngineFaultedError extends Error {
    readonly cause: unknown;

    constructor(
        public readonly fault: EngineFaultInfo,
        cause?: unknown,
    ) {
        super(`engine faulted: ${fault.message}`);
        this.name = "EngineFaultedError";
        this.cause = cause;
    }
}

// Bounds the undrained pruned-transaction backlog; the transport drains far below this every tick.
const MAX_PRUNED_TRANSACTION_IDS = 100_000;

// Ticks per epoch on the live network. A shorter one is how a test or the IDE reaches END_EPOCH without
// ticking three thousand times; 0 turns the rollover off entirely.
export const DEFAULT_EPOCH_LENGTH = 3000;

export class QubicSimulator {
    currentTick = 0;
    currentEpoch = 0;
    epochLength: number;
    host: HostServices;
    onLog?: LogSink;
    private registry: ContractRegistry;
    private spectrum = new SpectrumLedger({ tick: () => this.currentTick });
    private oracle: OracleManager;
    private pitDepth = 0;
    private assets = new AssetLedger({
        contractId: (slot) => this.contractId(slot),
        logAssetMutation: (type, message) => this.logStore?.logMessage(type, message, this.currentEpoch),
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
    private logStore?: QubicLogStore;
    private computorOverride = new Map<number, Uint8Array>();
    prevSpectrumDigestOverride?: Uint8Array;
    private readonly historyTicks: number;
    // Drained by the transport each tick. A caller that advances the simulator directly never drains it, so
    // the backlog is capped rather than growing for the life of the process.
    private prunedTransactionIds: string[] = [];
    private terminalFault: EngineFaultInfo | null = null;
    private lastFinalizedTick = 0;
    private lastFinalizedEpoch = 0;
    private pendingOracleNotifications: PendingOracleNotification[] = [];

    constructor(
        options: {
            consensus?: CommitteeOpts;
            mempool?: boolean;
            fees?: FeeMode;
            defaultReserve?: bigint;
            liteTicking?: boolean;
            logStore?: QubicLogStore;
            historyTicks?: number;
            epochLength?: number;
        } = {},
    ) {
        this.mempoolMode = options.mempool ?? false;
        this.epochLength = Math.max(0, Math.trunc(options.epochLength ?? DEFAULT_EPOCH_LENGTH));
        this.historyTicks = Math.max(1, Math.trunc(options.historyTicks ?? DEFAULT_TICK_HISTORY));
        this.fees = new FeeManager(options.fees ?? "off", options.defaultReserve);
        this.logStore = options.logStore;
        this.registry = new ContractRegistry(this.fees, this.recorder);
        this.ticking = new TickConsensus(
            {
                getSpectrumDigest: () => this.getSpectrumDigest(),
                getUniverseDigest: () => this.getUniverseDigest(),
                getComputerDigest: () => this.getComputerDigest(),
                tickTransactionDigests: (tick) => this.tickTransactions(tick).map((record) => record.digest),
                nowMs: () => this.nowMs(),
                tick: () => this.currentTick,
                epoch: () => this.currentEpoch,
            },
            options.consensus ?? {},
            options.liteTicking ?? true,
            this.historyTicks,
        );

        this.oracle = new OracleManager({
            energyOf: (slot) => this.balanceOf(slot),
            decreaseEnergyOf: (slot, amount) => {
                const source = this.contractId(slot);
                this.decreaseEnergy(this.spectrumIndex(source), amount);
                this.logQuTransfer(source, ZERO32, amount);
            },
            notify: (slot, procedureId, input) =>
                this.pendingOracleNotifications.push({
                    slot,
                    procedureId,
                    input: input.slice(),
                }),
            nowMs: () => this.nowMs(),
        });
        this.host = {
            tick: () => this.currentTick + this.cheatTickOffset,
            // Deliberately unshifted: a warp moves where the contract thinks it is within the epoch,
            // not where the epoch began, so `tick - initialTick` still reads as ticks elapsed.
            initialTick: () => this.currentEpoch * this.epochLength,
            epoch: () => this.currentEpoch + this.cheatEpochOffset,
            nowMs: () => this.nowMs(),
            numberOfTickTransactions: () => this.tickTxCount,
            markDirty: (slot) => this.dirty.add(slot),
            log: (slot, level, msg) => {
                this.recorder.log(level, msg);
                this.logStore?.log(slot, level, msg, this.currentEpoch);
            },
            cheatPrint: (slot, id, part, value, bytes) => this.recorder.cheat(slot, id, part, value, bytes),
            cheatDeal: (id, amount) => this.cheatDeal(id, amount),
            cheatWarp: (ticks, epochs) => {
                this.cheatTickOffset += ticks;
                this.cheatEpochOffset += epochs;
                return BigInt(ticks ? this.cheatTickOffset : this.cheatEpochOffset);
            },
            pauseLog: () => this.logStore?.pause(),
            resumeLog: () => this.logStore?.resume(),
            transfer: (slot, dest, amount, type) => this.transfer(slot, dest, amount, type),
            burn: (slot, amount, burnedFor) => this.burn(slot, amount, burnedFor),
            getEntity: (id) => this.getEntity(id),
            queryFeeReserve: (callerSlot, contractIndex) => this.fees.queryFeeReserve(callerSlot, contractIndex),
            issueAsset: (slot, name, issuer, decimals, shares, unit, invocator) =>
                this.assets.issueAsset(slot, name, issuer, decimals, shares, unit, invocator),
            isAssetIssued: (issuer, name) => (this.assets.isAssetIssued(issuer, name) ? 1 : 0),
            numberOfShares: (asset, ownership, possession) => this.assets.numberOfShares(asset, ownership, possession),
            numberOfPossessedShares: (name, issuer, owner, possessor, ownershipManager, possessionManager) =>
                this.assets.numberOfPossessedShares(name, issuer, owner, possessor, ownershipManager, possessionManager),
            assetEnumerate: (asset, ownership, possession, kind) => this.assets.enumerate(asset, ownership, possession, kind),
            transferShareOwnershipAndPossession: (slot, name, issuer, owner, possessor, shares, newOwner) =>
                this.assets.transferShareOwnershipAndPossession(slot, name, issuer, owner, possessor, shares, newOwner),
            acquireShares: (slot, name, issuer, owner, possessor, shares, sourceOwnershipManager, sourcePossessionManager, fee) =>
                this.acquireShares(slot, name, issuer, owner, possessor, shares, sourceOwnershipManager, sourcePossessionManager, fee),
            releaseShares: (slot, name, issuer, owner, possessor, shares, destinationOwnershipManager, destinationPossessionManager, fee) =>
                this.releaseShares(slot, name, issuer, owner, possessor, shares, destinationOwnershipManager, destinationPossessionManager, fee),
            dayOfWeek: (year, month, day) => (new Date(Date.UTC(2000 + year, month - 1, day)).getUTCDay() + 4) % 7,
            signatureValidity: (entity, digest, signature) => (verifySync(entity, digest, signature) ? 1 : 0),
            bidInIPO: () => -1n,
            ipoBidId: (_contractIndex, index) =>
                index >= 0 && index < IPO_SHARE_COUNT ? this.ticking.getCommittee().computors[index % this.ticking.committeeSize()].publicKey : ZERO32,
            ipoBidPrice: (_contractIndex, index) => (index >= 0 && index < IPO_SHARE_COUNT ? IPO_SHARE_PRICE : -3n),
            computeMiningFunction: () => ZERO32,
            initMiningSeed: () => {},
            getOracleQueryStatus: (queryId) => this.oracle.getOracleQueryStatus(queryId),
            getOcInvocationStatus: () => 0,
            invokeOc: () => -1n,
            unsubscribeOracle: (slot, subscriptionId) => this.oracle.stopContractSubscription(slot, subscriptionId),
            queryOracle: (slot, interfaceIndex, query, replySize, procedureId, timeout, fee) => {
                if (!this.isValidOracleCallback(slot, procedureId, replySize)) {
                    return -1n;
                }

                return this.oracle.startContractQuery(slot, interfaceIndex, query, replySize, procedureId, timeout, fee);
            },
            subscribeOracle: (slot, interfaceIndex, query, replySize, timestampOffset, procedureId, period, notifyPrevious, fee) => {
                if (!this.isValidOracleCallback(slot, procedureId, replySize)) {
                    return -1;
                }

                return this.oracle.startContractSubscription(slot, interfaceIndex, query, replySize, timestampOffset, procedureId, period, notifyPrevious, fee);
            },
            getOracleQuery: (queryId) => this.oracle.getOracleQuery(queryId),
            getOracleReply: (queryId) => this.oracle.getOracleReply(queryId),
            isContractId: (id) => (this.isContractAddress(id) ? 1 : 0),
            arbitrator: () => this.ticking.getCommittee().arbitrator.publicKey,
            computor: (index) =>
                this.computorOverride.get(index >>> 0) ?? this.ticking.getCommittee().computors[index % this.ticking.committeeSize()]?.publicKey ?? ZERO32,
            getPrevSpectrumDigest: () => this.prevSpectrumDigestOverride ?? this.ticking.getPrevSpectrumDigest(),
            getPrevUniverseDigest: () => this.ticking.getPrevUniverseDigest(),
            getPrevComputerDigest: () => this.ticking.getPrevComputerDigest(),
            distributeDividends: (slot, amountPerShare) => this.distributeDividends(slot, amountPerShare),
            callFunction: (callerSlot, calleeIndex, inputType, input, originator) => this.callFunction(callerSlot, calleeIndex, inputType, input, originator),
            invokeProcedure: (callerSlot, calleeIndex, inputType, input, reward, originator) =>
                this.invokeProcedure(callerSlot, calleeIndex, inputType, input, reward, originator),
            nextId: (id) => this.nextId(id),
            prevId: (id) => this.prevId(id),
            setShareholderProposal: (callerSlot, calleeIndex, proposal, reward, originator) =>
                this.setShareholderProposal(callerSlot, calleeIndex, proposal, reward, originator),
            setShareholderVotes: (callerSlot, calleeIndex, vote, reward, originator) =>
                this.setShareholderVotes(callerSlot, calleeIndex, vote, reward, originator),
        };
    }

    faultInfo(): EngineFaultInfo | null {
        return this.terminalFault ? { ...this.terminalFault } : null;
    }

    attachFaultTransaction(txId: string): void {
        if (this.terminalFault && !this.terminalFault.txId) {
            this.terminalFault.txId = txId;
        }
    }

    isFaulted(): boolean {
        return this.terminalFault !== null;
    }

    finalizedTick(): number {
        return this.lastFinalizedTick;
    }

    finalizedEpoch(): number {
        return this.lastFinalizedEpoch;
    }

    bootstrapEpoch(epoch = 1): void {
        this.assertOperational();
        if (
            this.currentTick !== 0 ||
            this.currentEpoch !== 0 ||
            this.lastFinalizedTick !== 0 ||
            this.lastFinalizedEpoch !== 0 ||
            this.contracts.size !== 0 ||
            this.txpool.size !== 0
        ) {
            throw new Error("epoch bootstrap requires a pristine simulator");
        }

        const normalizedEpoch = Math.max(0, Math.trunc(epoch));
        const initialTick = normalizedEpoch * this.epochLength;
        this.currentEpoch = normalizedEpoch;
        this.currentTick = initialTick;
        this.lastFinalizedEpoch = normalizedEpoch;
        this.lastFinalizedTick = initialTick;
        this.oracle.beginEpoch();
        this.pendingOracleNotifications = [];
        this.logStore?.reset(initialTick);
    }

    assertOperational(): void {
        if (this.terminalFault) {
            throw new EngineFaultedError(this.terminalFault);
        }
    }

    // The first fault is the one that describes the halt; later ones are consequences of it.
    private recordFault(error: unknown, phase: string, txId?: string): EngineFaultInfo {
        const contractError = error instanceof ContractExecutionError ? error : null;
        const fault: EngineFaultInfo = {
            message: String((error as Error)?.message ?? error),
            phase,
            failedTick: this.currentTick,
            failedEpoch: this.currentEpoch,
            lastFinalizedTick: this.lastFinalizedTick,
            lastFinalizedEpoch: this.lastFinalizedEpoch,
            slot: contractError?.slot,
            kind: contractError?.kind,
            entry: contractError?.entry,
            txId,
        };

        this.terminalFault ??= fault;

        return this.terminalFault;
    }

    private runOperation<T>(
        phase: string,
        operation: () => T,
        context: {
            txId?: string;
            contractErrorsOnly?: boolean;
        } = {},
    ): T {
        this.assertOperational();

        try {
            return operation();
        } catch (error) {
            if (error instanceof EngineFaultedError) {
                throw error;
            }

            const contractError = error instanceof ContractExecutionError ? error : null;
            if (context.contractErrorsOnly && !contractError) {
                throw error;
            }

            throw new EngineFaultedError(this.recordFault(error, phase, context.txId), error);
        }
    }

    getContractFeeReserve(slot: number): bigint {
        return this.fees.getContractFeeReserve(slot);
    }

    setContractFeeReserve(slot: number, amount: bigint): void {
        this.assertOperational();
        this.fees.setContractFeeReserve(slot, amount);
    }

    ipo(slot: number, finalPrice: bigint): void {
        this.assertOperational();
        this.fees.ipo(slot, finalPrice);
    }

    get contracts(): Map<number, Contract> {
        return this.registry.contracts;
    }

    get dirty(): Set<number> {
        return this.registry.dirty;
    }

    // How far back finalized ticks are still kept. Anything older has been pruned and reads as an empty tick.
    get tickHistoryDepth(): number {
        return this.historyTicks;
    }

    contractId(slot: number): Uint8Array {
        const id = ContractId.alloc();
        id.lane0 = BigInt(slot);
        return id.bytes;
    }

    private key(id: Id): string {
        return toHex(id.subarray(0, 32));
    }

    getEntity(id: Id): Entity | null {
        return this.spectrum.getEntity(id);
    }

    spectrumIndex(publicKey: Id): number {
        return this.spectrum.spectrumIndex(publicKey);
    }

    // Core has no id-keyed energy read — it resolves a spectrum index first. Kept as a convenience.
    // Warp offsets shift only what a contract observes; the chain's own tick and epoch are untouched.
    private cheatTickOffset = 0;
    private cheatEpochOffset = 0;

    /** Sets a balance outright rather than transferring, which is the point of a deal. */
    private cheatDeal(id: Id, amount: bigint): bigint {
        // The amount arrives as an unsigned word, so anything past the signed range lands here
        // negative. A negative balance is meaningless, and would decrease against a missing entry.
        if (amount < 0n) {
            return CHEAT_ERR.unknownOp;
        }

        const current = this.balance(id);

        if (current > amount) {
            this.decreaseEnergy(this.spectrumIndex(id), current - amount);
        } else if (current < amount) {
            this.increaseEnergy(id, amount - current);
        }

        return amount;
    }

    balance(id: Id): bigint {
        return this.spectrum.energy(this.spectrum.spectrumIndex(id));
    }

    balanceOf(slot: number): bigint {
        return this.balance(this.contractId(slot));
    }

    energy(index: number): bigint {
        return this.spectrum.energy(index);
    }

    increaseEnergy(publicKey: Id, amount: bigint): void {
        this.assertOperational();
        this.spectrum.increaseEnergy(publicKey, amount);
    }

    decreaseEnergy(index: number, amount: bigint): boolean {
        this.assertOperational();
        return this.spectrum.decreaseEnergy(index, amount);
    }

    fund(id: Id, amount: bigint): void {
        this.assertOperational();
        this.spectrum.increaseEnergy(id, amount);
    }

    private logQuTransfer(source: Id, destination: Id, amount: bigint): void {
        this.logStore?.logMessage(QUBIC_LOG_TYPE.QU_TRANSFER, encodeQuTransferLog(source, destination, amount), this.currentEpoch);
    }

    private transferBalance(source: Id, destination: Id, amount: bigint): boolean {
        if (!this.decreaseEnergy(this.spectrumIndex(source), amount)) {
            return false;
        }
        this.increaseEnergy(destination, amount);
        this.logQuTransfer(source, destination, amount);
        return true;
    }

    notifyIncomingTransfer(source: Id, destination: Id, amount: bigint, type: number): void {
        this.assertOperational();
        if (!this.decreaseEnergy(this.spectrumIndex(source), amount)) {
            return;
        }
        this.increaseEnergy(destination, amount);
        this.notifyContractOfIncomingTransfer(destination, source, amount, type);
        this.logQuTransfer(source, destination, amount);
    }

    setComputorKey(index: number, key: Uint8Array): void {
        this.assertOperational();
        if (key.every((byte) => byte === 0)) {
            this.computorOverride.delete(index >>> 0);
        } else {
            this.computorOverride.set(index >>> 0, key.slice(0, 32));
        }
    }

    resetLedger(): void {
        this.assertOperational();
        this.spectrum = new SpectrumLedger({ tick: () => this.currentTick });
        this.assets = new AssetLedger({
            contractId: (slot) => this.contractId(slot),
            logAssetMutation: (type, message) => this.logStore?.logMessage(type, message, this.currentEpoch),
        });
    }

    nextId(id: Id): Uint8Array {
        return this.spectrum.nextId(id);
    }

    prevId(id: Id): Uint8Array {
        return this.spectrum.prevId(id);
    }

    contractSlotOf(id: Id): number {
        const contractId = ContractId.wrap(id);
        if (contractId.lane1 !== 0n || contractId.lane2 !== 0n || contractId.lane3 !== 0n) {
            return -1;
        }

        const slot = Number(contractId.lane0);
        return this.contracts.has(slot) ? slot : -1;
    }

    isContractAddress(id: Id): boolean {
        const contractId = ContractId.wrap(id);
        return contractId.lane1 === 0n && contractId.lane2 === 0n && contractId.lane3 === 0n && contractId.lane0 < BigInt(MAX_NUMBER_OF_CONTRACTS);
    }

    private transfer(slot: number, destination: Id, amount: bigint, type: number): bigint {
        if (this.pitDepth > 0 && this.contractSlotOf(destination) >= 0) {
            return INVALID_AMOUNT;
        }
        if (amount < 0n || amount > MAX_AMOUNT) {
            return -(MAX_AMOUNT + 1n);
        }

        const source = this.contractId(slot);
        const sourceIndex = this.spectrumIndex(source);
        if (sourceIndex < 0) {
            return -amount;
        }
        const remaining = this.energy(sourceIndex) - amount;
        if (remaining < 0n) {
            return remaining;
        }

        this.decreaseEnergy(sourceIndex, amount);
        this.increaseEnergy(destination, amount);
        this.notifyContractOfIncomingTransfer(destination, source, amount, type);
        this.logQuTransfer(source, destination, amount);

        return remaining;
    }

    private burn(slot: number, amount: bigint, burnedFor: number): bigint {
        if (amount < 0n || amount > MAX_AMOUNT) {
            return -(MAX_AMOUNT + 1n);
        }

        const target = burnedFor < 1 || burnedFor >= MAX_NUMBER_OF_CONTRACTS ? slot : burnedFor;
        if (this.fees.metered && this.fees.isFailed(target)) {
            return -amount;
        }

        const source = this.contractId(slot);
        const sourceIndex = this.spectrumIndex(source);
        if (sourceIndex < 0) {
            return -amount;
        }
        const remaining = this.energy(sourceIndex) - amount;
        if (remaining < 0n) {
            return remaining;
        }

        this.decreaseEnergy(sourceIndex, amount);
        if (this.fees.metered) {
            this.fees.addToContractFeeReserve(target, amount);
        }
        this.logStore?.logMessage(QUBIC_LOG_TYPE.BURNING, encodeBurningLog(source, amount, target), this.currentEpoch);

        return remaining;
    }

    transferShareManagementRights(name: bigint, issuer: Id, owner: Id, possessor: Id, srcMgmt: number, dstMgmt: number, shares: bigint): boolean {
        this.assertOperational();
        return this.assets.transferShareManagementRights(name, issuer, owner, possessor, srcMgmt, dstMgmt, shares);
    }

    private runManagementCallback(
        targetSlot: number,
        spId: number,
        name: bigint,
        issuer: Id,
        owner: Id,
        possessor: Id,
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

        const output = this.registry.fire(contract, CONTRACT_ENTRY_KIND.SYSPROC, spId, request.bytes, {
            entryPoint: spId,
        });
        const reply = PreManagementRightsTransferOutput.wrap(output);
        const allow = output.length >= 1 && reply.allowTransfer !== 0;
        const requestedFee = output.length >= 16 ? reply.requestedFee : 0n;

        return { allow, fee: requestedFee };
    }

    // acquireShares and releaseShares are the same protocol run in opposite directions: one side asks the
    // other's management contract for permission, pays the fee it names, then the rights move.
    private moveManagementRights(request: {
        callerSlot: number;
        name: bigint;
        issuer: Id;
        owner: Id;
        possessor: Id;
        shares: bigint;
        offeredFee: bigint;
        counterpartyOwnershipManager: number;
        counterpartyPossessionManager: number;
        preSysproc: number;
        postSysproc: number;
        // Release moves rights away from the caller; acquire pulls them in from the counterparty.
        heldByCaller: boolean;
    }): bigint {
        const { callerSlot, name, issuer, owner, possessor, shares, offeredFee } = request;
        const { counterpartyOwnershipManager, counterpartyPossessionManager, heldByCaller } = request;

        this.assertOperational();
        if (!first32BytesEqual(owner, possessor) || counterpartyOwnershipManager !== counterpartyPossessionManager) {
            return INVALID_AMOUNT;
        }

        if (
            counterpartyPossessionManager === callerSlot ||
            counterpartyPossessionManager < 1 ||
            counterpartyPossessionManager >= MAX_NUMBER_OF_CONTRACTS ||
            shares <= 0n ||
            offeredFee < 0n
        ) {
            return INVALID_AMOUNT;
        }

        const holder = heldByCaller ? callerSlot : counterpartyPossessionManager;
        const availableShares = this.assets.numberOfPossessedShares(name, issuer, owner, possessor, holder, holder);
        if (availableShares < shares) {
            return INVALID_AMOUNT;
        }

        const callback = this.runManagementCallback(
            counterpartyOwnershipManager,
            request.preSysproc,
            name,
            issuer,
            owner,
            possessor,
            shares,
            offeredFee,
            callerSlot,
        );

        if (!callback.allow || callback.fee < 0n || callback.fee > MAX_AMOUNT) {
            return INVALID_AMOUNT;
        }

        if (callback.fee > offeredFee) {
            return -callback.fee;
        }

        if (callback.fee > 0n) {
            const feeResult = this.transfer(callerSlot, this.contractId(counterpartyOwnershipManager), callback.fee, TRANSFER_TYPE_QPI_TRANSFER);
            if (feeResult < 0n) {
                return -callback.fee;
            }
        }

        const from = heldByCaller ? callerSlot : counterpartyPossessionManager;
        const to = heldByCaller ? counterpartyPossessionManager : callerSlot;
        if (!this.transferShareManagementRights(name, issuer, owner, possessor, from, to, shares)) {
            return INVALID_AMOUNT;
        }

        this.runManagementCallback(counterpartyOwnershipManager, request.postSysproc, name, issuer, owner, possessor, shares, callback.fee, callerSlot);

        return callback.fee;
    }

    acquireShares(
        callerSlot: number,
        name: bigint,
        issuer: Id,
        owner: Id,
        possessor: Id,
        shares: bigint,
        sourceOwnershipManager: number,
        sourcePossessionManager: number,
        offeredFee: bigint,
    ): bigint {
        return this.moveManagementRights({
            callerSlot,
            name,
            issuer,
            owner,
            possessor,
            shares,
            offeredFee,
            counterpartyOwnershipManager: sourceOwnershipManager,
            counterpartyPossessionManager: sourcePossessionManager,
            preSysproc: SYSTEM_PROCEDURES.PRE_RELEASE_SHARES,
            postSysproc: SYSTEM_PROCEDURES.POST_RELEASE_SHARES,
            heldByCaller: false,
        });
    }

    releaseShares(
        callerSlot: number,
        name: bigint,
        issuer: Id,
        owner: Id,
        possessor: Id,
        shares: bigint,
        destinationOwnershipManager: number,
        destinationPossessionManager: number,
        offeredFee: bigint,
    ): bigint {
        return this.moveManagementRights({
            callerSlot,
            name,
            issuer,
            owner,
            possessor,
            shares,
            offeredFee,
            counterpartyOwnershipManager: destinationOwnershipManager,
            counterpartyPossessionManager: destinationPossessionManager,
            preSysproc: SYSTEM_PROCEDURES.PRE_ACQUIRE_SHARES,
            postSysproc: SYSTEM_PROCEDURES.POST_ACQUIRE_SHARES,
            heldByCaller: true,
        });
    }

    private distributeDividends(slot: number, amountPerShare: bigint): number {
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
        if (!this.decreaseEnergy(this.spectrumIndex(contractId), total)) {
            return 0;
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
            this.increaseEnergy(possession.possessor, dividend);
            this.notifyContractOfIncomingTransfer(possession.possessor, contractId, dividend, TRANSFER_TYPE_QPI_DISTRIBUTE_DIVIDENDS);
            this.logQuTransfer(contractId, possession.possessor, dividend);
        }

        return 1;
    }

    private contractAssetNames = new Map<number, bigint>();

    setContractAssetName(slot: number, name: bigint | string): void {
        this.assertOperational();
        this.contractAssetNames.set(slot, typeof name === "string" ? packAssetName(name) : name & 0xffffffffffffffn);
    }

    mintDeployShares(slot: number, name: bigint | string, holder: Id): void {
        this.assertOperational();
        const packedName = typeof name === "string" ? packAssetName(name) : name & 0xffffffffffffffn;
        this.setContractAssetName(slot, packedName);

        if (this.assets.isAssetIssued(ZERO32, packedName)) {
            return;
        }

        this.assets.mintContractShares(1, packedName, BigInt(IPO_SHARE_COUNT));
        this.assets.transferShareOwnershipAndPossession(1, packedName, ZERO32, ZERO32, ZERO32, BigInt(IPO_SHARE_COUNT), holder);
    }

    assetUniverse(): AssetSnapshot[] {
        return this.assets.assetUniverse();
    }

    private notifyContractOfIncomingTransfer(destination: Id, source: Id, amount: bigint, type: number): void {
        if (amount <= 0n) {
            return;
        }

        const slot = this.contractSlotOf(destination);
        if (slot < 0) {
            return;
        }

        const contract = this.contracts.get(slot)!;
        if (!contract.hasSysproc(SYSTEM_PROCEDURES.POST_INCOMING_TRANSFER)) {
            return;
        }

        const notice = PostIncomingTransferInput.alloc();
        notice.source = source;
        notice.amount = amount;
        notice.type = type;
        const input = notice.bytes;

        this.pitDepth++;
        try {
            this.registry.fire(contract, CONTRACT_ENTRY_KIND.SYSPROC, SYSTEM_PROCEDURES.POST_INCOMING_TRANSFER, input, {
                entryPoint: SYSTEM_PROCEDURES.POST_INCOMING_TRANSFER,
            });
        } finally {
            this.pitDepth--;
        }
    }

    deploy(slot: number, wasm: Uint8Array, externalMemory?: WebAssembly.Memory): Contract {
        return this.runOperation(
            "deploy",
            () => {
                this.logStore?.begin(this.nextLogTick(), LOG_SC_INITIALIZE);
                let contract: Contract;

                try {
                    contract = this.registry.deploy(slot, wasm, this.host, externalMemory);
                } finally {
                    this.logStore?.end();
                }

                this.emit("info", "deploy", `slot ${slot} deployed · ${(wasm.length / 1024) | 0}KB wasm`);
                if (contract.stateSize > K12_MAX_LEAF_BYTES) {
                    this.emit(
                        "warn",
                        "digest",
                        `slot ${slot} state ${(contract.stateSize / 1048576) | 0}MB > ${K12_MAX_LEAF_BYTES / 1048576}MB — excluded from computer digest (zero leaf)`,
                    );
                }

                return contract;
            },
            { contractErrorsOnly: true },
        );
    }

    deployWithImports(slot: number, wasm: Uint8Array, imports: WebAssembly.Imports): Contract {
        return this.runOperation(
            "deploy",
            () => {
                this.logStore?.begin(this.nextLogTick(), LOG_SC_INITIALIZE);
                try {
                    return this.registry.deploy(slot, wasm, this.host, undefined, imports);
                } finally {
                    this.logStore?.end();
                }
            },
            { contractErrorsOnly: true },
        );
    }

    undeploy(slot: number): boolean {
        this.assertOperational();
        const removed = this.registry.undeploy(slot);
        if (removed) {
            this.emit("info", "deploy", `slot ${slot} undeployed`);
        }

        return removed;
    }

    setDebug(on: boolean): void {
        this.recorder.setEnabled(on);
    }

    getTrace(since?: number, limit?: number): DebugTrace {
        return this.recorder.trace(since, limit);
    }

    private emit(level: LogLevel, category: string, message: string): void {
        this.onLog?.({
            level,
            tick: this.currentTick,
            cat: category,
            msg: message,
        });
    }

    private nextLogTick(): number {
        return Math.max(this.currentTick, this.lastFinalizedTick + 1);
    }

    private isValidOracleCallback(slot: number, procedureId: number, replySize: number): boolean {
        if (replySize < 0) {
            return false;
        }

        return (
            this.contracts
                .get(slot)
                ?.entries.some(
                    (entry) =>
                        entry.kind === CONTRACT_ENTRY_KIND.PROCEDURE && entry.inputType === (procedureId & 0xffff) && entry.inputSizeBytes === 16 + replySize,
                ) ?? false
        );
    }

    private deliverOracleNotifications(): void {
        if (this.pendingOracleNotifications.length === 0) {
            return;
        }

        this.logStore?.begin(this.currentTick, LOG_SC_NOTIFICATION);
        try {
            while (this.pendingOracleNotifications.length > 0) {
                const notification = this.pendingOracleNotifications.shift()!;
                const contract = this.contracts.get(notification.slot);
                if (!contract) {
                    continue;
                }

                this.registry.fire(contract, CONTRACT_ENTRY_KIND.PROCEDURE, notification.procedureId, notification.input, {
                    invocator: ZERO32,
                    originator: ZERO32,
                    invocationReward: 0n,
                    entryPoint: EP_USER_PROCEDURE_NOTIFICATION,
                });
            }
        } finally {
            this.logStore?.end();
        }
    }

    // Fires one system procedure across every registered contract that implements it. Begin-phases walk the
    // slots ascending and end-phases descending; the tick phases additionally skip a contract out of fees.
    private contractProcessor(sysproc: number, ascendingSlots: boolean, requireFeeReserve: boolean): void {
        for (const slot of this.registry.slots(ascendingSlots)) {
            const contract = this.contracts.get(slot)!;
            if (!contract.hasSysproc(sysproc)) {
                continue;
            }
            if (requireFeeReserve && !this.fees.reserveOk(slot)) {
                continue;
            }

            this.registry.fire(contract, CONTRACT_ENTRY_KIND.SYSPROC, sysproc, new Uint8Array(0), { entryPoint: sysproc });
        }
    }

    beginEpoch(): void {
        this.runOperation("begin-epoch", () => this.runBeginEpoch());
    }

    private runBeginEpoch(): void {
        this.oracle.beginEpoch();
        this.pendingOracleNotifications = [];
        const logTick = this.nextLogTick();
        this.logStore?.reset(logTick);
        this.logStore?.begin(logTick, LOG_SC_BEGIN_EPOCH);

        try {
            this.contractProcessor(SYSTEM_PROCEDURES.BEGIN_EPOCH, true, false);
        } finally {
            this.logStore?.end();
        }
    }

    endEpoch(): void {
        this.runOperation("end-epoch", () => this.runEndEpoch());
    }

    private runEndEpoch(): void {
        this.logStore?.begin(this.nextLogTick(), LOG_SC_END_EPOCH);

        try {
            this.contractProcessor(SYSTEM_PROCEDURES.END_EPOCH, false, false);
        } finally {
            this.logStore?.end();
        }
    }

    beginTick(): void {
        this.runOperation("begin-tick", () => this.runBeginTick());
    }

    private runBeginTick(): void {
        this.currentTick++;
        this.tickTxCount = this.txpool.dueCount(this.currentTick);
        this.emit("debug", "tick", `tick ${this.currentTick} begin · ${this.tickTxCount} tx`);

        this.logStore?.begin(this.currentTick, LOG_SC_BEGIN_TICK);
        try {
            this.contractProcessor(SYSTEM_PROCEDURES.BEGIN_TICK, true, true);
        } finally {
            this.logStore?.end();
        }
    }

    endTick(): void {
        this.runOperation("end-tick", () => this.runEndTick());
    }

    private runEndTick(): void {
        this.logStore?.begin(this.currentTick, LOG_SC_END_TICK);

        try {
            this.contractProcessor(SYSTEM_PROCEDURES.END_TICK, false, true);
        } finally {
            this.logStore?.end();
        }

        this.emit("debug", "tick", `tick ${this.currentTick} end`);
    }

    advance(): void {
        this.runOperation("advance-tick", () => this.runAdvance());
    }

    private runAdvance(): void {
        const nextTick = this.currentTick + 1;

        if (this.epochLength > 0 && nextTick % this.epochLength === 0) {
            this.endEpoch();
            this.logStore?.finalizeTick(nextTick);
            this.currentEpoch++;
            this.beginEpoch();
            this.emit("info", "epoch", `epoch ${this.currentEpoch - 1} → ${this.currentEpoch}`);
        }

        this.beginTick();
        this.drainMempool();
        this.oracle.pump();
        this.deliverOracleNotifications();
        this.endTick();
        this.ticking.finalizeTick();
        this.logStore?.finalizeTick(this.currentTick);
        this.lastFinalizedTick = this.currentTick;
        this.lastFinalizedEpoch = this.currentEpoch;
        this.prunedTransactionIds.push(...this.txpool.pruneFinalized(this.currentTick, this.historyTicks));
        if (this.prunedTransactionIds.length > MAX_PRUNED_TRANSACTION_IDS) {
            this.prunedTransactionIds = this.prunedTransactionIds.slice(-MAX_PRUNED_TRANSACTION_IDS);
        }
    }

    query(slot: number, inputType: number, input?: Uint8Array): Uint8Array {
        this.assertOperational();
        const contract = this.contracts.get(slot);
        const entry = contract?.entries.find((candidate) => candidate.kind === CONTRACT_ENTRY_KIND.FUNCTION && candidate.inputType === inputType);
        if (!contract || !entry) {
            throw new Error(`unknown contract function ${slot}:${inputType}`);
        }

        return this.runOperation("contract-function", () => contract.invoke(CONTRACT_ENTRY_KIND.FUNCTION, inputType, input), { contractErrorsOnly: true });
    }

    // Runs the user procedure only. Each caller fires POST_INCOMING_TRANSFER for the reward beforehand, because
    // core resets the action tracker here and money moved by the callback must not count towards moneyFlew.
    private processTickTransactionContractProcedure(
        slot: number,
        inputType: number,
        input: Uint8Array,
        invocator: Id,
        originator: Id,
        reward: bigint,
    ): Uint8Array {
        const contract = this.contracts.get(slot)!;

        return this.registry.fire(contract, CONTRACT_ENTRY_KIND.PROCEDURE, inputType, input, {
            invocator,
            originator,
            invocationReward: reward,
            entryPoint: EP_USER_PROCEDURE,
        });
    }

    resolveOracle(queryId: bigint, reply: Uint8Array, status?: number): boolean {
        return this.runOperation(
            "oracle-notification",
            () => (status === undefined ? this.oracle.resolve(queryId, reply) : this.oracle.resolve(queryId, reply, status)),
            { contractErrorsOnly: true },
        );
    }

    pendingOracleQueries(): {
        queryId: bigint;
        slot: number;
        interfaceIndex: number;
        query: Uint8Array;
    }[] {
        return this.oracle.pending();
    }

    setOracleProvider(provider: ((interfaceIndex: number, query: Uint8Array) => Uint8Array | null) | null): void {
        this.assertOperational();
        this.oracle.setProvider(provider);
    }

    callFunction(callerSlot: number, calleeIndex: number, inputType: number, input: Uint8Array, originator: Id): { error: number; output: Uint8Array } {
        this.assertOperational();
        const callee = this.contracts.get(calleeIndex);
        if (!callee || calleeIndex >= callerSlot) {
            return { error: CALL_ERROR_CONTRACT_INACTIVE, output: EMPTY };
        }
        if (!this.fees.reserveOk(calleeIndex)) {
            return { error: CALL_ERROR_INSUFFICIENT_FEES, output: EMPTY };
        }
        if (this.callDepth >= NUMBER_OF_CONTRACT_EXECUTION_BUFFERS) {
            return { error: CALL_ERROR_ALLOCATION_FAILED, output: EMPTY };
        }

        this.callDepth++;

        try {
            const invocator = this.contractId(callerSlot);
            const output = callee.invoke(CONTRACT_ENTRY_KIND.FUNCTION, inputType, input, {
                invocator,
                originator,
                invocationReward: 0n,
                entryPoint: EP_USER_FUNCTION,
            });
            return { error: NO_CALL_ERROR, output };
        } catch (error) {
            return this.nestedTrapResult(callee, CONTRACT_ENTRY_KIND.FUNCTION, inputType, error, "contract-function");
        } finally {
            this.callDepth--;
        }
    }

    invokeProcedure(
        callerSlot: number,
        calleeIndex: number,
        inputType: number,
        input: Uint8Array,
        reward: bigint,
        originator: Id,
    ): { error: number; output: Uint8Array } {
        this.assertOperational();
        const callee = this.contracts.get(calleeIndex);
        if (!callee || calleeIndex >= callerSlot) {
            return { error: CALL_ERROR_CONTRACT_INACTIVE, output: EMPTY };
        }
        if (!this.fees.reserveOk(calleeIndex)) {
            return { error: CALL_ERROR_INSUFFICIENT_FEES, output: EMPTY };
        }
        if (this.callDepth >= NUMBER_OF_CONTRACT_EXECUTION_BUFFERS) {
            return { error: CALL_ERROR_ALLOCATION_FAILED, output: EMPTY };
        }

        const transferredReward = this.transferInvocationReward(callerSlot, calleeIndex, reward);

        this.callDepth++;

        try {
            const invocator = this.contractId(callerSlot);
            // transferInvocationReward already fired the callee's POST_INCOMING_TRANSFER for the reward.
            const output = this.processTickTransactionContractProcedure(calleeIndex, inputType, input, invocator, originator, transferredReward);
            return { error: NO_CALL_ERROR, output };
        } catch (error) {
            return this.nestedTrapResult(callee, CONTRACT_ENTRY_KIND.PROCEDURE, inputType, error, "contract-procedure");
        } finally {
            this.callDepth--;
        }
    }

    // A callee that aborted deliberately halts the node, exactly as the same abort does at the top level.
    // A Wasm trap stays recoverable: Core keeps ticking through one, and the caller gets NoCallError with
    // a zero-filled output, which is the only shape it has for "the callee produced nothing".
    private nestedTrapResult(
        callee: Contract,
        kind: number,
        inputType: number,
        error: unknown,
        phase: string,
    ): { error: number; output: Uint8Array } {
        if (!(error instanceof ContractExecutionError)) {
            throw error;
        }
        if (error.cause instanceof ContractAbort) {
            // Recorded here rather than in an enclosing runOperation: these two entry points are also
            // called directly, where there is no enclosing operation to record the fault.
            this.recordFault(error, phase);
            throw error;
        }

        const outputSize = callee.entries.find((entry) => entry.kind === kind && entry.inputType === inputType)?.outputSizeBytes;
        return {
            error: NO_CALL_ERROR,
            output: new Uint8Array(outputSize ?? 0),
        };
    }

    private transferInvocationReward(callerSlot: number, calleeIndex: number, reward: bigint): bigint {
        const callerId = this.contractId(callerSlot);
        if (this.pitDepth > 0 || reward < 0n || reward > MAX_AMOUNT || !this.decreaseEnergy(this.spectrumIndex(callerId), reward)) {
            return 0n;
        }

        const calleeId = this.contractId(calleeIndex);
        this.increaseEnergy(calleeId, reward);
        this.notifyContractOfIncomingTransfer(calleeId, callerId, reward, TRANSFER_TYPE_PROCEDURE_INVOCATION_BY_OTHER_CONTRACT);
        this.logQuTransfer(callerId, calleeId, reward);
        return reward;
    }

    setShareholderProposal(callerSlot: number, calleeIndex: number, proposal: Uint8Array, reward: bigint, originator: Id): number {
        this.assertOperational();
        if (calleeIndex === callerSlot || calleeIndex === 0 || !this.contracts.has(calleeIndex) || reward < 0n) {
            return INVALID_PROPOSAL_INDEX;
        }
        if (this.callDepth >= NUMBER_OF_CONTRACT_EXECUTION_BUFFERS) {
            return INVALID_PROPOSAL_INDEX;
        }

        const callee = this.contracts.get(calleeIndex)!;
        if (!callee.hasSysproc(SYSTEM_PROCEDURES.SET_SHAREHOLDER_PROPOSAL) || !this.fees.reserveOk(calleeIndex)) {
            return INVALID_PROPOSAL_INDEX;
        }

        const invocationReward = this.transferInvocationReward(callerSlot, calleeIndex, reward);

        this.callDepth++;

        try {
            const output = this.registry.fire(callee, CONTRACT_ENTRY_KIND.SYSPROC, SYSTEM_PROCEDURES.SET_SHAREHOLDER_PROPOSAL, proposal, {
                invocator: this.contractId(callerSlot),
                originator,
                invocationReward,
                entryPoint: SYSTEM_PROCEDURES.SET_SHAREHOLDER_PROPOSAL,
            });

            return output.length >= 2 ? new DataView(output.buffer, output.byteOffset, output.byteLength).getUint16(0, true) : 0;
        } finally {
            this.callDepth--;
        }
    }

    setShareholderVotes(callerSlot: number, calleeIndex: number, vote: Uint8Array, reward: bigint, originator: Id): number {
        this.assertOperational();
        if (calleeIndex === callerSlot || calleeIndex === 0 || !this.contracts.has(calleeIndex) || reward < 0n) {
            return 0;
        }
        if (this.callDepth >= NUMBER_OF_CONTRACT_EXECUTION_BUFFERS) {
            return 0;
        }

        const callee = this.contracts.get(calleeIndex)!;
        if (!callee.hasSysproc(SYSTEM_PROCEDURES.SET_SHAREHOLDER_VOTES) || !this.fees.reserveOk(calleeIndex)) {
            return 0;
        }

        const invocationReward = this.transferInvocationReward(callerSlot, calleeIndex, reward);

        this.callDepth++;

        try {
            const output = this.registry.fire(callee, CONTRACT_ENTRY_KIND.SYSPROC, SYSTEM_PROCEDURES.SET_SHAREHOLDER_VOTES, vote, {
                invocator: this.contractId(callerSlot),
                originator,
                invocationReward,
                entryPoint: SYSTEM_PROCEDURES.SET_SHAREHOLDER_VOTES,
            });

            return output.length >= 1 ? output[0] : 0;
        } finally {
            this.callDepth--;
        }
    }

    procedure(slot: number, inputType: number, input?: Uint8Array, options: ProcedureCallOptions = {}): Uint8Array {
        this.assertOperational();
        const contract = this.contracts.get(slot);
        const entry = contract?.entries.find((candidate) => candidate.kind === CONTRACT_ENTRY_KIND.PROCEDURE && candidate.inputType === inputType);
        if (!contract || !entry) {
            throw new Error(`unknown contract procedure ${slot}:${inputType}`);
        }

        const reward = options.reward ?? 0n;
        const invocator = options.invocator ?? ZERO32;
        const originator = options.originator ?? invocator;

        if (!this.fees.reserveOk(slot)) {
            return EMPTY;
        }

        return this.runOperation(
            "contract-procedure",
            () => {
                if (reward > 0n) {
                    this.increaseEnergy(this.contractId(slot), reward);
                    this.notifyContractOfIncomingTransfer(this.contractId(slot), invocator, reward, TRANSFER_TYPE_PROCEDURE_TRANSACTION);
                }

                return this.processTickTransactionContractProcedure(slot, inputType, input ?? new Uint8Array(0), invocator, originator, reward);
            },
            { contractErrorsOnly: true },
        );
    }

    processTickTransaction(
        source: Id,
        destination: Id,
        amount: bigint,
        inputType: number,
        payload: Uint8Array,
        txId: string,
        digest: Uint8Array = ZERO32,
    ): { moneyFlew: boolean } {
        this.assertOperational();
        if (this.isContractAddress(source)) {
            throw new Error("contract addresses cannot sign transactions");
        }
        if (this.txpool.txByHash(txId)) {
            throw new Error(`duplicate transaction ${txId}`);
        }
        if (amount < 0n || amount > MAX_AMOUNT) {
            throw new Error(`invalid transaction amount ${amount}`);
        }
        if (payload.length > MAX_INPUT_SIZE) {
            throw new Error(`transaction input exceeds ${MAX_INPUT_SIZE} bytes`);
        }

        const tick = this.currentTick;
        const txIndex = this.txpool.tickTransactions(tick).length;
        if (txIndex >= TXS_PER_TICK) {
            throw new Error(`tick ${tick} already has ${TXS_PER_TICK} transactions`);
        }

        return this.runOperation(
            "transaction",
            () => {
                this.logStore?.begin(this.nextLogTick(), txIndex);
                try {
                    const sourceIndex = this.spectrumIndex(source);
                    const slot = this.contractSlotOf(destination);
                    let moneyFlew = false;

                    if (this.transferBalance(source, destination, amount)) {
                        if (amount > 0n) {
                            moneyFlew = true;
                        }

                        if (slot >= 0) {
                            const contract = this.contracts.get(slot)!;
                            const isProcedure = contract.entries.some((entry) => entry.kind === CONTRACT_ENTRY_KIND.PROCEDURE && entry.inputType === inputType);

                            // A dormant contract takes no transaction at all — the amount goes back and neither the
                            // procedure nor the incoming-transfer callback runs.
                            if (!this.fees.reserveOk(slot)) {
                                if (amount > 0n) {
                                    this.transferBalance(destination, source, amount);
                                }
                                moneyFlew = false;

                                this.emit("warn", "fee", `slot ${slot} dormant — tx it=${inputType} skipped${amount > 0n ? `, refunded ${amount}` : ""}`);
                            } else if (isProcedure) {
                                if (amount > 0n) {
                                    this.notifyContractOfIncomingTransfer(destination, source, amount, TRANSFER_TYPE_PROCEDURE_TRANSACTION);
                                }

                                // moneyFlew mirrors core's action tracker, which starts at the user procedure seeded with
                                // the invocation reward: what the callback moved is already water under the bridge.
                                const sourceBalanceAfterCallback = this.energy(sourceIndex);
                                this.processTickTransactionContractProcedure(slot, inputType, payload, source, source, amount);
                                moneyFlew = this.energy(sourceIndex) - sourceBalanceAfterCallback - amount !== 0n;
                            } else if (amount > 0n) {
                                this.notifyContractOfIncomingTransfer(destination, source, amount, TRANSFER_TYPE_STANDARD_TRANSACTION);
                            }
                        }
                    }

                    this.emit("info", "tx", `tx → ${slot >= 0 ? `slot ${slot}` : "user"} it=${inputType} amount=${amount} moneyFlew=${moneyFlew}`);
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
                    this.logStore?.end();
                }
            },
            { txId },
        );
    }

    // Queue future transactions in mempool mode; otherwise apply them immediately.
    enqueueTx(
        scheduledTick: number,
        source: Id,
        destination: Id,
        amount: bigint,
        inputType: number,
        payload: Uint8Array,
        txId: string,
        digest: Uint8Array = ZERO32,
    ): { moneyFlew: boolean; queued: boolean } {
        this.assertOperational();
        if (this.txpool.has(txId)) {
            throw new Error(`duplicate transaction ${txId}`);
        }

        if (!this.mempoolMode || scheduledTick <= this.currentTick) {
            const result = this.processTickTransaction(source, destination, amount, inputType, payload, txId, digest);

            return { moneyFlew: result.moneyFlew, queued: false };
        }

        if (this.txpool.dueCount(scheduledTick) >= TXS_PER_TICK) {
            throw new Error(`tick ${scheduledTick} already has ${TXS_PER_TICK} queued transactions`);
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
        for (const transaction of this.txpool.takeDue(this.currentTick)) {
            this.processTickTransaction(
                transaction.source,
                transaction.dest,
                transaction.amount,
                transaction.inputType,
                transaction.payload,
                transaction.txId,
                transaction.digest,
            );
        }
    }

    tickTransactions(tick: number): TxRecord[] {
        if (this.terminalFault && tick > this.lastFinalizedTick) {
            return [];
        }

        return this.txpool.tickTransactions(tick);
    }

    txByHash(txId: string): TxRecord | undefined {
        const transaction = this.txpool.txByHash(txId);
        if (this.terminalFault && transaction && transaction.tick > this.lastFinalizedTick) {
            return undefined;
        }

        return transaction;
    }

    takePrunedTransactionIds(): string[] {
        const ids = this.prunedTransactionIds;
        this.prunedTransactionIds = [];
        return ids;
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
        return this.timeBaseMs + this.currentTick * this.tickDuration;
    }

    numberOfEntities(): number {
        return this.spectrum.numberOfEntities;
    }

    // Txs still waiting for their scheduled tick (mempool mode only — otherwise always empty).
    mempoolCounts(): { tick: number; count: number }[] {
        return this.txpool.pendingByTick();
    }

    spectrumInfo(): { totalAmount: bigint; numberOfEntities: number } {
        return {
            totalAmount: this.spectrum.totalAmount(),
            numberOfEntities: this.spectrum.numberOfEntities,
        };
    }

    txCount(): number {
        return this.txpool.size;
    }

    getComputerDigest(): Uint8Array {
        return this.registry.getComputerDigest();
    }

    getSpectrumDigest(): Uint8Array {
        return this.spectrum.getSpectrumDigest();
    }

    getUniverseDigest(): Uint8Array {
        return this.assets.getUniverseDigest();
    }

    universeProofOwned(ownerId: Id) {
        return this.assets.universeProofOwned(ownerId);
    }

    universeProofPossessed(possessorId: Id) {
        return this.assets.universeProofPossessed(possessorId);
    }

    universeProofAt(index: number) {
        return this.assets.universeProofAt(index);
    }

    universeProofIssuances(filter: AssetIssuanceFilter = {}) {
        return this.assets.universeProofIssuances(filter);
    }

    universeProofOwnerships(filter: AssetOwnershipFilter) {
        return this.assets.universeProofOwnerships(filter);
    }

    universeProofPossessions(filter: AssetPossessionFilter) {
        return this.assets.universeProofPossessions(filter);
    }

    spectrumProof(id: Id): {
        record: Uint8Array;
        index: number;
        siblings: Uint8Array[];
    } {
        return this.spectrum.spectrumProof(id);
    }

    tickRecord(tick: number): TickRecord | undefined {
        return tick <= this.lastFinalizedTick ? this.ticking.tickRecord(tick) : undefined;
    }

    tickData(tick: number): TickData | undefined {
        return tick <= this.lastFinalizedTick ? this.ticking.tickData(tick) : undefined;
    }

    alignedVotes(tick = this.currentTick): number {
        return tick <= this.lastFinalizedTick ? this.ticking.alignedVotes(tick) : 0;
    }

    signedComputorList(slotCount?: number): Uint8Array {
        return this.ticking.signedComputorList(slotCount);
    }
}
