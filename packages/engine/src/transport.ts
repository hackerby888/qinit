import type {
    NodeTransport,
    TxStatus,
    StateRead,
    TickInfo,
    DynamicContractRegistry,
    DynamicContractRegistryEntry,
    DynamicContractEntry,
    DynamicContractUploadStatus,
    DeployOutcome,
    DeployOutcomeCode,
    DebugTrace,
    EngineFaultInfo,
    BroadcastResult,
    EntityInfo,
    TxInfo,
} from "@qinit/core";
import {
    bytesToIdentity,
    identityToBytes,
    DEFAULT_WASM_SLOT_LAYOUT,
    LITE_DEPLOY_ADDRESS,
    TESTNET_FUNDED_SEEDS,
    WASM_ABI_VERSION,
    hexToBytes,
} from "@qinit/core";
import { CORE_IO_CAPACITY_BYTES } from "@qinit/core/wasm/sizing";
import { LITE_TX, CHUNK_DATA_MAX, MAX_INPUT_SIZE, UploadBegin, UploadChunkHeader, DeployMessage } from "@qinit/proto";
import { QubicSimulator, EngineFaultedError, type AssetSnapshot, type FeeMode, type ProcedureCallOptions } from "./qubic-simulator";
import type { LogSink } from "./logging/log";
import type { CommitteeOpts } from "./chain/consensus";
import { Contract, CONTRACT_ENTRY_KIND } from "./contract/runtime";
import { k12Bytes, toHex, verifySync, deriveKeysSync, initK12 } from "./support/k12";
import { Transaction } from "./protocol/wire";
import { QubicLogStore } from "./logging/qubic-log-store";
import { bytesEqual, type Id } from "./support/bytes";
import { MAX_AMOUNT } from "./ledger/assets";
import { ExplorerReadModel } from "./explorer";

interface DeployedContractMetadata {
    name: string;
    codeHash: string;
    version: number;
}
interface UploadSession {
    sessionId: bigint;
    totalSize: number;
    chunkCount: number;
    buf: Uint8Array;
    received: Set<number>;
    finalHash: string;
    lastProgressTick: number;
}

// An upload that receives nothing for this many ticks is dropped, matching the node's limit.
const UPLOAD_STALE_TICKS = 32;

interface StoredRawTransaction {
    txId: string;
    bytes: Uint8Array;
}

const MAX_WASM_MODULE_SIZE = 4 * 1024 * 1024;
const DEPLOY_HEADER_SIZE = DeployMessage.SIZE - 32;
// core's MAX_CONTRACT_STATE_SIZE; the staging route is unauthenticated, so the allocation is capped
const MAX_STAGED_STATE_BYTES = 1024 * 1024 * 1024;

interface StagedState {
    bytes: Uint8Array;
    receivedBytes: number;
}

export type StageStateResult = { ok: true; received: number; total: number } | { ok: false; message: string };

export interface VirtualNodeOptions {
    slotBase?: number;
    slotCount?: number;
    consensus?: CommitteeOpts;
    mempool?: boolean;
    verifySigs?: boolean;
    fees?: FeeMode;
    defaultReserve?: bigint;
    liteTicking?: boolean;
    historyTicks?: number;
    maxLogBytes?: number;
    epochLength?: number;
    // the smallest io region a deployed module may report. It defaults to core's capacity, so a node refuses what core refuses; 0 accepts any.
    minIoBytes?: number;
}

export class VirtualNode implements NodeTransport {
    readonly sim: QubicSimulator;
    readonly logger: QubicLogStore;
    readonly slotBase: number;
    readonly slotCount: number;
    private readonly minIoBytes: number;
    // what a node holds when its options name no minimum. The test suite lowers it, since its fixtures carry a small arena.
    static defaultMinIoBytes = CORE_IO_CAPACITY_BYTES;
    private slotMeta = new Map<number, DeployedContractMetadata>();
    private slotsByName = new Map<string, number>();
    private upload: UploadSession | null = null;
    private lastDeploy: DeployOutcome | null = null;
    private contractSources = new Map<number, string>();
    private stagedStates = new Map<number, StagedState>();
    private rawTransactions = new Map<string, StoredRawTransaction>();
    private rawAliasesByTxId = new Map<string, string[]>();
    private fundedSeedPool: string[] | null = null;
    private static readonly FUNDED_POOL_SIZE = 16;

    private verifySignatures: boolean;
    readonly explorer = new ExplorerReadModel(this);

    get onLog(): LogSink | undefined {
        return this.sim.onLog;
    }

    set onLog(sink: LogSink | undefined) {
        this.sim.onLog = sink;
    }

    static async create(options: VirtualNodeOptions = {}): Promise<VirtualNode> {
        await initK12();
        return new VirtualNode(options);
    }

    constructor(options: VirtualNodeOptions = {}) {
        this.logger = new QubicLogStore(options.maxLogBytes);
        this.slotBase = options.slotBase ?? DEFAULT_WASM_SLOT_LAYOUT.slotBase;
        this.slotCount = options.slotCount ?? DEFAULT_WASM_SLOT_LAYOUT.slotCount;
        this.sim = new QubicSimulator({
            contractCount: this.slotBase + this.slotCount,
            consensus: options.consensus,
            mempool: options.mempool ?? true,
            fees: options.fees ?? "metered",
            defaultReserve: options.defaultReserve,
            liteTicking: options.liteTicking,
            logStore: this.logger,
            historyTicks: options.historyTicks,
            epochLength: options.epochLength,
        });
        // Align the live simulator node with core's wall clock; gtest and fuzz build their own QubicSimulator and keep the deterministic 2024 base.
        this.sim.timeBaseMs = Date.now();
        this.sim.clockMode = "real";
        this.verifySignatures = options.verifySigs ?? true;
        this.minIoBytes = options.minIoBytes ?? VirtualNode.defaultMinIoBytes;
    }

    feeReserve(slot: number): bigint {
        return this.sim.getContractFeeReserve(slot);
    }

    setContractFeeReserve(slot: number, amount: bigint): void {
        this.sim.setContractFeeReserve(slot, amount);
    }

    ipo(slot: number, finalPrice: bigint): void {
        this.sim.ipo(slot, finalPrice);
    }

    deploy(wasm: Uint8Array, options?: { name?: string; slot?: number; deployer?: Uint8Array; deferActivation?: boolean }): Contract;
    deploy(slot: number, wasm: Uint8Array, name?: string, deployer?: Uint8Array): Contract;
    deploy(
        slotOrWasm: number | Uint8Array,
        wasmOrOptions?: Uint8Array | { name?: string; slot?: number; deployer?: Uint8Array; deferActivation?: boolean },
        contractName?: string,
        contractDeployer?: Uint8Array,
    ): Contract {
        let wasm: Uint8Array;
        let name: string | undefined;
        let explicitSlot: number | undefined;
        let deployer: Uint8Array | undefined;
        // only a deploy that arrives over the network waits for the next tick, as a core node makes it; an embedder's own call constructs at once.
        let deferActivation = false;

        if (typeof slotOrWasm === "number") {
            explicitSlot = slotOrWasm;
            wasm = wasmOrOptions as Uint8Array;
            name = contractName;
            deployer = contractDeployer;
        } else {
            wasm = slotOrWasm;
            const options =
                (wasmOrOptions as {
                    name?: string;
                    slot?: number;
                    deployer?: Uint8Array;
                    deferActivation?: boolean;
                }) ?? {};
            name = options.name;
            explicitSlot = options.slot;
            deployer = options.deployer;
            deferActivation = options.deferActivation ?? false;
        }

        const slot = this.resolveDeploymentSlot(explicitSlot, name);
        const contract = this.sim.deploy(slot, wasm, undefined, {
            initialState: this.takeStagedState(slot),
            minIoBytes: this.minIoBytes,
            deferActivation,
        });
        if (name !== undefined) {
            this.slotsByName.set(name, slot);
        }
        this.slotMeta.set(slot, {
            name: name ?? "Contract",
            codeHash: toHex(k12Bytes(wasm)),
            version: (this.slotMeta.get(slot)?.version ?? 0) + 1,
        });

        const ticker =
            (name ?? "Contract")
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "")
                .slice(0, 7) || "C";
        this.sim.mintDeployShares(slot, ticker, deployer ?? this.sim.getCommittee().arbitrator.publicKey);

        return contract;
    }

    // stage an initial state in ordered chunks; the next deploy of the slot takes it. a zero total clears the entry.
    stageState(slot: number, offset: number, total: number, chunk: Uint8Array): StageStateResult {
        const validSlot = Number.isInteger(slot) && slot >= 1 && slot < this.slotBase + this.slotCount;
        if (!validSlot) {
            return { ok: false, message: `slot ${slot} is outside 1..${this.slotBase + this.slotCount - 1}` };
        }
        if (!Number.isInteger(total) || total < 0 || total > MAX_STAGED_STATE_BYTES) {
            return { ok: false, message: `total ${total} is outside 0..${MAX_STAGED_STATE_BYTES}` };
        }
        if (total === 0) {
            this.stagedStates.delete(slot);
            return { ok: true, received: 0, total: 0 };
        }

        if (offset === 0) {
            this.stagedStates.set(slot, { bytes: new Uint8Array(total), receivedBytes: 0 });
        }

        const staged = this.stagedStates.get(slot);
        if (!staged || staged.bytes.length !== total || offset !== staged.receivedBytes) {
            return { ok: false, message: `chunk at ${offset} is out of order; expected ${staged?.receivedBytes ?? 0}` };
        }
        if (offset + chunk.length > total) {
            return { ok: false, message: `chunk at ${offset} overruns the ${total} B total` };
        }

        staged.bytes.set(chunk, offset);
        staged.receivedBytes += chunk.length;

        return { ok: true, received: staged.receivedBytes, total };
    }

    // a deploy always consumes the entry, so a half-staged state never reaches a later deploy.
    private takeStagedState(slot: number): Uint8Array | undefined {
        const staged = this.stagedStates.get(slot);
        this.stagedStates.delete(slot);

        return staged && staged.receivedBytes === staged.bytes.length ? staged.bytes : undefined;
    }

    private resolveDeploymentSlot(explicitSlot: number | undefined, name: string | undefined): number {
        if (explicitSlot !== undefined) {
            return explicitSlot;
        }

        if (name !== undefined && this.slotsByName.has(name)) {
            return this.slotsByName.get(name)!;
        }

        const taken = new Set(this.slotsByName.values());
        let slot = this.slotBase;

        while (this.sim.contracts.has(slot) || taken.has(slot)) {
            slot++;
        }

        return slot;
    }

    slotOf(name: string): number | undefined {
        return this.slotsByName.get(name);
    }

    advanceTick(count = 1): number {
        for (let index = 0; index < count; index++) {
            this.sim.advance();
            for (const txId of this.sim.takePrunedTransactionIds()) {
                for (const alias of this.rawAliasesByTxId.get(txId) ?? []) {
                    this.rawTransactions.delete(alias);
                }
                this.rawAliasesByTxId.delete(txId);
            }
        }

        return this.sim.currentTick;
    }

    epochInfo(): {
        epoch: number;
        tick: number;
        initialTick: number;
        epochLastTick: number;
        ticksLeft: number;
        duration: number;
    } {
        const epochLength = this.sim.epochLength;
        const fault = this.sim.faultInfo();
        const tick = fault?.lastFinalizedTick ?? this.sim.currentTick;
        const epoch = fault?.lastFinalizedEpoch ?? this.sim.currentEpoch;
        const initialTick = this.sim.initialTick;
        const epochLastTick = epochLength > 0 ? initialTick + epochLength - 1 : tick;

        return {
            epoch,
            tick,
            initialTick,
            epochLastTick,
            ticksLeft: Math.max(0, epochLastTick - tick),
            duration: epochLength,
        };
    }

    advanceTickN(count: number): {
        from: number;
        requested: number;
        target: number;
        reached: number;
        epochLastTick: number;
        cappedAtEpochEnd: boolean;
    } {
        const from = this.sim.currentTick;
        const epochLastTick = this.epochInfo().epochLastTick;
        const target = Math.min(from + Math.max(0, count), epochLastTick);

        this.advanceTick(Math.max(0, target - from));

        return {
            from,
            requested: count,
            target,
            reached: this.sim.currentTick,
            epochLastTick,
            cappedAtEpochEnd: from + count > epochLastTick,
        };
    }

    advanceToLast(gap = 3): {
        from: number;
        target: number;
        reached: number;
        epochLastTick: number;
        epoch: number;
    } {
        const from = this.sim.currentTick;
        const epochLastTick = this.epochInfo().epochLastTick;
        const target = Math.max(from, epochLastTick - Math.max(0, gap));

        this.advanceTick(Math.max(0, target - from));

        return {
            from,
            target,
            reached: this.sim.currentTick,
            epochLastTick,
            epoch: this.sim.currentEpoch,
        };
    }

    advanceEpoch(): {
        fromEpoch: number;
        toEpoch: number;
        fromTick: number;
        tick: number;
        initialTick: number;
        switched: boolean;
    } {
        const fromEpoch = this.sim.currentEpoch;
        const fromTick = this.sim.currentTick;
        const epochLength = this.sim.epochLength;

        if (epochLength > 0) {
            // a length shortened mid-epoch can leave the tick already past the switch point, where the very next tick switches.
            this.advanceTick(Math.max(1, this.sim.initialTick + epochLength + 1 - fromTick));
        }

        const toEpoch = this.sim.currentEpoch;

        return {
            fromEpoch,
            toEpoch,
            fromTick,
            tick: this.sim.currentTick,
            initialTick: this.sim.initialTick,
            switched: toEpoch > fromEpoch,
        };
    }

    async tickInfo(): Promise<TickInfo> {
        const fault = this.sim.faultInfo();
        return {
            tick: fault ? fault.lastFinalizedTick : this.sim.currentTick,
            epoch: fault ? fault.lastFinalizedEpoch : this.sim.currentEpoch,
            fault: fault ?? undefined,
        };
    }

    async faultInfo(): Promise<EngineFaultInfo | null> {
        return this.sim.faultInfo();
    }

    async dynRegistry(): Promise<DynamicContractRegistry> {
        const contracts: DynamicContractRegistryEntry[] = [];

        const deployedContract = (slot: number, contract: Contract, metadata: DeployedContractMetadata): DynamicContractRegistryEntry => {
            const entries = (kind: number): DynamicContractEntry[] =>
                contract.entries
                    .filter((entry) => entry.kind === kind)
                    .map((entry) => ({
                        inputType: entry.inputType,
                        inputSize: entry.inputSizeBytes,
                        outputSize: entry.outputSizeBytes,
                    }));

            return {
                index: slot,
                armed: true,
                constructed: !this.sim.isActivationPending(slot),
                version: metadata.version,
                name: metadata.name,
                codeHash: metadata.codeHash,
                functions: entries(CONTRACT_ENTRY_KIND.FUNCTION),
                procedures: entries(CONTRACT_ENTRY_KIND.PROCEDURE),
                source: this.contractSources.get(slot),
                feeReserve: this.sim.getContractFeeReserve(slot).toString(),
                // what this phase has run up but not charged yet; feeReserve only moves at the boundary.
                executionFee: this.sim.executionFee(slot).toString(),
            };
        };

        for (let slot = this.slotBase; slot < this.slotBase + this.slotCount; slot++) {
            const contract = this.sim.contracts.get(slot);
            const metadata = this.slotMeta.get(slot);

            if (!contract || !metadata) {
                contracts.push({
                    index: slot,
                    armed: false,
                    constructed: false,
                    version: 0,
                    name: "",
                    codeHash: "",
                    functions: [],
                    procedures: [],
                });
                continue;
            }

            contracts.push(deployedContract(slot, contract, metadata));
        }

        for (const [slot, contract] of this.sim.contracts) {
            const isUserSlot = slot >= this.slotBase && slot < this.slotBase + this.slotCount;
            if (isUserSlot) {
                continue;
            }

            const metadata = this.slotMeta.get(slot);
            if (metadata) {
                contracts.push(deployedContract(slot, contract, metadata));
            }
        }

        contracts.sort((left, right) => left.index - right.index);

        return { contracts, slotBase: this.slotBase, slotCount: this.slotCount };
    }

    undeploy(slot: number): boolean {
        this.sim.assertOperational();
        const name = this.slotMeta.get(slot)?.name;
        if (name !== undefined && this.slotsByName.get(name) === slot) {
            this.slotsByName.delete(name);
        }

        this.slotMeta.delete(slot);
        this.contractSources.delete(slot);

        return this.sim.undeploy(slot);
    }

    private uploadIdleTicks(): number {
        return this.upload ? Math.max(0, this.sim.currentTick - this.upload.lastProgressTick) : 0;
    }

    // Deploy transactions are handled at broadcast time, so the idle check runs whenever a session is looked at.
    private dropStaleUpload(): void {
        if (this.upload && this.uploadIdleTicks() > UPLOAD_STALE_TICKS) {
            this.upload = null;
        }
    }

    async dynUpload(): Promise<DynamicContractUploadStatus> {
        this.dropStaleUpload();
        const upload = this.upload;
        if (!upload) {
            return {
                active: false,
                sessionId: "0",
                totalSize: 0,
                chunkSize: CHUNK_DATA_MAX,
                chunkCount: 0,
                receivedCount: 0,
                complete: false,
                finalHash: "",
                missing: [],
                missingCount: 0,
                idleTicks: 0,
                staleAfterTicks: UPLOAD_STALE_TICKS,
                lastProgressTick: 0,
                lastDeploy: this.lastDeploy,
            };
        }

        const missing: number[] = [];

        for (let index = 0; index < upload.chunkCount; index++) {
            if (!upload.received.has(index)) {
                missing.push(index);
            }
        }

        return {
            active: true,
            sessionId: upload.sessionId.toString(),
            totalSize: upload.totalSize,
            chunkSize: CHUNK_DATA_MAX,
            chunkCount: upload.chunkCount,
            receivedCount: upload.received.size,
            complete: missing.length === 0,
            finalHash: upload.finalHash,
            missing,
            missingCount: missing.length,
            idleTicks: this.uploadIdleTicks(),
            staleAfterTicks: UPLOAD_STALE_TICKS,
            lastProgressTick: upload.lastProgressTick,
            lastDeploy: this.lastDeploy,
        };
    }

    async txStatus(tick: number, txId: string): Promise<TxStatus> {
        const transaction = this.sim.txByHash(txId);
        const currentTick = this.sim.isFaulted() ? this.sim.finalizedTick() : this.sim.currentTick;
        const processed = currentTick > tick;

        return {
            tick,
            currentTick,
            txId,
            found: transaction !== undefined,
            moneyFlew: transaction?.moneyFlew ?? false,
            processed,
        };
    }

    async querySmartContract(contractIndex: number, inputType: number, input: Uint8Array): Promise<Uint8Array> {
        return this.sim.query(contractIndex, inputType, input);
    }

    procedure(slot: number, inputType: number, input?: Uint8Array, options?: ProcedureCallOptions): Uint8Array {
        return this.sim.procedure(slot, inputType, input, options);
    }

    query(slot: number, inputType: number, input?: Uint8Array): Uint8Array {
        return this.sim.query(slot, inputType, input);
    }

    getComputerDigest(): Uint8Array {
        return this.sim.getComputerDigest();
    }

    getSpectrumDigest(): Uint8Array {
        return this.sim.getSpectrumDigest();
    }

    getUniverseDigest(): Uint8Array {
        return this.sim.getUniverseDigest();
    }

    async broadcastTx(txBytes: Uint8Array): Promise<BroadcastResult> {
        this.sim.assertOperational();
        try {
            const signatureSize = 64;
            const minimumSize = Transaction.HEADER_SIZE + signatureSize;
            if (txBytes.length < minimumSize) {
                return { ok: false, message: "transaction is shorter than its fixed fields" };
            }

            const transaction = Transaction.wrap(txBytes);
            const expectedSize = Transaction.HEADER_SIZE + transaction.inputSize + signatureSize;
            if (transaction.inputSize > MAX_INPUT_SIZE) {
                return {
                    ok: false,
                    message: `transaction input exceeds ${MAX_INPUT_SIZE} bytes`,
                };
            }
            if (txBytes.length !== expectedSize) {
                return {
                    ok: false,
                    message: `transaction size ${txBytes.length} does not match declared size ${expectedSize}`,
                };
            }

            const source = transaction.sourcePublicKey.bytes.slice();
            const destination = transaction.destinationPublicKey.bytes.slice();
            const amount = transaction.amount;
            const scheduledTick = transaction.tick;
            const inputType = transaction.inputType;
            const payload = transaction.input.slice();
            if (amount < 0n || amount > MAX_AMOUNT) {
                return { ok: false, message: `invalid transaction amount ${amount}` };
            }
            if (this.sim.isContractAddress(source)) {
                return {
                    ok: false,
                    message: "contract addresses cannot sign transactions",
                };
            }

            const epochLastTick = this.epochInfo().epochLastTick;
            if (scheduledTick <= this.sim.currentTick || scheduledTick > epochLastTick) {
                return {
                    ok: false,
                    message: `transaction tick ${scheduledTick} is outside ${this.sim.currentTick + 1}..${epochLastTick}`,
                };
            }

            const body = txBytes.subarray(0, expectedSize - signatureSize);

            if (this.verifySignatures) {
                const signature = txBytes.subarray(expectedSize - signatureSize);
                const isValid = verifySync(source, k12Bytes(body), signature);

                if (!isValid) {
                    return { ok: false, message: "invalid signature" };
                }
            }

            const txId = await this.txId(txBytes);
            this.sim.assertOperational();
            const fullDigest = k12Bytes(txBytes);
            const aliases = [toHex(k12Bytes(body)), toHex(fullDigest), txId];
            if (aliases.some((alias) => this.rawTransactions.has(alias))) {
                return { ok: false, message: `duplicate transaction ${txId}` };
            }

            if (bytesEqual(destination, LITE_DEPLOY_ADDRESS)) {
                try {
                    this.handleDeployTx(inputType, payload, source);
                } catch (error) {
                    if (error instanceof EngineFaultedError) {
                        this.sim.attachFaultTransaction(txId);
                    }
                    throw error;
                }
                return { ok: true, transactionId: txId };
            }

            const { moneyFlew, queued } = this.sim.enqueueTx(scheduledTick, source, destination, amount, inputType, payload, txId, fullDigest);
            this.storeRawTransaction(txId, aliases, txBytes);

            return { ok: true, transactionId: txId, moneyFlew, queued };
        } catch (error) {
            if (error instanceof EngineFaultedError) {
                throw error;
            }
            const message = String((error as Error)?.message ?? error);
            return { ok: false, message };
        }
    }

    private storeRawTransaction(txId: string, aliases: string[], txBytes: Uint8Array): void {
        const uniqueAliases = [...new Set(aliases)];
        const stored = { txId, bytes: txBytes };
        for (const alias of uniqueAliases) {
            this.rawTransactions.set(alias, stored);
        }
        this.rawAliasesByTxId.set(txId, uniqueAliases);
    }

    private async txId(txBytes: Uint8Array): Promise<string> {
        return (await bytesToIdentity(k12Bytes(txBytes))).toLowerCase();
    }

    private handleDeployTx(inputType: number, payload: Uint8Array, source?: Id): void {
        if (inputType === LITE_TX.UPLOAD_BEGIN) {
            if (payload.length < UploadBegin.SIZE) {
                throw new Error("upload begin payload is too short");
            }
            const message = UploadBegin.wrap(payload);

            this.dropStaleUpload();
            if (this.upload) {
                if (this.upload.sessionId !== message.sessionId) {
                    throw new Error(
                        `another contract upload is active (session ${this.upload.sessionId}, ${this.upload.received.size}/${this.upload.chunkCount} chunks); wait for it to complete`,
                    );
                }

                return;
            }

            const totalSize = message.totalSize;
            const expectedChunkCount = Math.ceil(totalSize / CHUNK_DATA_MAX);
            if (totalSize < 1 || totalSize > MAX_WASM_MODULE_SIZE) {
                throw new Error(`module size must be between 1 and ${MAX_WASM_MODULE_SIZE} bytes`);
            }
            if (message.chunkCount !== expectedChunkCount) {
                throw new Error(`upload declares ${message.chunkCount} chunks; expected ${expectedChunkCount}`);
            }
            this.upload = {
                sessionId: message.sessionId,
                totalSize,
                chunkCount: message.chunkCount,
                buf: new Uint8Array(totalSize),
                received: new Set(),
                finalHash: toHex(message.finalHash),
                lastProgressTick: this.sim.currentTick,
            };

            return;
        }

        if (inputType === LITE_TX.UPLOAD_CHUNK) {
            const upload = this.upload;
            if (!upload) {
                throw new Error("upload chunk without an active session");
            }
            if (payload.length < UploadChunkHeader.SIZE) {
                throw new Error("upload chunk payload is too short");
            }

            const message = UploadChunkHeader.wrap(payload);
            if (message.sessionId !== upload.sessionId) {
                throw new Error("upload chunk for a different session");
            }
            if (message.seq >= upload.chunkCount) {
                throw new Error(`upload chunk ${message.seq} is outside 0..${upload.chunkCount - 1}`);
            }
            // a chunk names its own offset, so arrival order is free; a repeat must not rewrite bytes already taken.
            if (upload.received.has(message.seq)) {
                throw new Error(`upload chunk ${message.seq} was already received`);
            }

            const offset = message.seq * CHUNK_DATA_MAX;
            const expectedLength = Math.min(CHUNK_DATA_MAX, upload.totalSize - offset);
            if (message.len !== expectedLength || payload.length !== UploadChunkHeader.SIZE + message.len) {
                throw new Error(`upload chunk ${message.seq} has invalid length ${message.len}; expected ${expectedLength}`);
            }

            upload.buf.set(payload.subarray(UploadChunkHeader.SIZE), offset);
            upload.received.add(message.seq);
            upload.lastProgressTick = this.sim.currentTick;

            return;
        }

        if (inputType === LITE_TX.DEPLOY) {
            if (payload.length < DEPLOY_HEADER_SIZE) {
                throw new Error("deploy payload is too short");
            }

            // the checks run in core's order and carry core's wording, so a client reads one reason whichever node refused.
            const message = DeployMessage.wrap(payload);
            const refuse = (code: DeployOutcomeCode, reason: string): never => {
                this.recordDeployOutcome(message.sessionId, message.targetSlot, code, reason);
                throw new Error(reason);
            };
            const upload = this.upload;

            if (message.targetSlot < this.slotBase || message.targetSlot >= this.slotBase + this.slotCount) {
                return refuse("bad-slot", `slot ${message.targetSlot} is not a dynamic contract slot`);
            }
            if (message.abiVersion !== WASM_ABI_VERSION) {
                return refuse("abi-mismatch", `unsupported Wasm ABI version ${message.abiVersion}; expected ${WASM_ABI_VERSION}`);
            }
            if (!upload || message.sessionId !== upload.sessionId) {
                return refuse("session-mismatch", `session ${message.sessionId} is not the upload session on this node`);
            }
            if (upload.received.size !== upload.chunkCount) {
                return refuse("incomplete", `upload incomplete (${upload.received.size}/${upload.chunkCount} chunks)`);
            }
            if (!bytesEqual(k12Bytes(upload.buf), hexToBytes(upload.finalHash))) {
                return refuse("hash-mismatch", "uploaded bytes do not hash to the digest the upload announced");
            }
            if (!bytesEqual(message.finalHash, hexToBytes(upload.finalHash))) {
                return refuse("hash-mismatch", "deploy names a different module digest than the upload");
            }
            // from here core has committed to loading, and it frees the session whichever way that goes, so a refused module never holds the node's one upload slot.
            if (upload.buf.length < 4 || upload.buf[0] !== 0x00 || upload.buf[1] !== 0x61 || upload.buf[2] !== 0x73 || upload.buf[3] !== 0x6d) {
                this.upload = null;
                return refuse("not-wasm", "upload is not a wasm module ('\\0asm' expected)");
            }

            const rawName = payload.length >= DeployMessage.SIZE ? new TextDecoder().decode(message.name) : "";
            const name = rawName.replace(/[^\x20-\x7e].*$/, "") || "Contract";

            try {
                this.deploy(upload.buf, { slot: message.targetSlot, name, deployer: source, deferActivation: true });
            } catch (error) {
                if (!(error instanceof EngineFaultedError)) {
                    this.recordDeployOutcome(message.sessionId, message.targetSlot, "load-failed", error instanceof Error ? error.message : String(error));
                }
                throw error;
            } finally {
                this.upload = null;
            }
            this.recordDeployOutcome(message.sessionId, message.targetSlot, "ok", "slot armed");

            return;
        }

        throw new Error("unknown deploy-range inputType " + inputType);
    }

    // a client resends DEPLOY until the slot arms, so a session's verdict stands once given: only an upload that was still missing chunks can
    // end differently.
    private recordDeployOutcome(sessionId: bigint, slot: number, code: DeployOutcomeCode, message: string): void {
        const stored = this.lastDeploy;
        if (stored && stored.sessionId === sessionId.toString() && stored.code !== "incomplete") {
            return;
        }

        this.lastDeploy = { sessionId: sessionId.toString(), slot, tick: this.sim.currentTick, ok: code === "ok", code, message };
    }

    async debugTrace(since = 0, limit = 64): Promise<DebugTrace> {
        return this.sim.getTrace(since, limit);
    }

    assetUniverse(): AssetSnapshot[] {
        return this.sim.assetUniverse();
    }

    async setDebug(on: boolean): Promise<{ enabled: boolean }> {
        this.sim.setDebug(on);
        return { enabled: on };
    }

    async oraclePending(): Promise<
        {
            queryId: bigint;
            slot: number;
            interfaceIndex: number;
            query: Uint8Array;
        }[]
    > {
        return this.sim.pendingOracleQueries();
    }

    async oracleResolve(queryId: bigint, reply: Uint8Array, status?: number): Promise<{ ok: boolean }> {
        return { ok: this.sim.resolveOracle(queryId, reply, status) };
    }

    async stateRead(slot: number, off: number, len: number): Promise<StateRead> {
        const { bytes, stateSize } = this.stateBytes(slot, off, len);

        return {
            off,
            len,
            stateSize,
            hex: toHex(bytes),
            version: this.sim.stateVersion(slot),
        };
    }

    // a copy, not a view: the response is sent after this returns, and a tick may write the slot in between
    stateBytes(slot: number, off: number, len: number): { bytes: Uint8Array; stateSize: number } {
        const contract = this.sim.contracts.get(slot);
        const state = contract?.stateView() ?? new Uint8Array(0);

        return { bytes: state.slice(off, off + len), stateSize: contract?.stateSize ?? 0 };
    }

    fundedPool(): string[] {
        if (this.fundedSeedPool) {
            return this.fundedSeedPool;
        }
        // The testnet seeds come first so a picker offers one that works on a real testnet node; the derived pool behind them keeps the old accounts funded.
        const encoder = new TextEncoder();
        const seeds = [...TESTNET_FUNDED_SEEDS, "a".repeat(55)];

        for (let seedIndex = 1; seedIndex < VirtualNode.FUNDED_POOL_SIZE; seedIndex++) {
            const bytes = [...k12Bytes(encoder.encode("qinit/funded-seed/" + seedIndex)), ...k12Bytes(encoder.encode("qinit/funded-seed/" + seedIndex + "#"))];

            let seed = "";
            for (let byteIndex = 0; byteIndex < 55; byteIndex++) {
                seed += String.fromCharCode(97 + (bytes[byteIndex] % 26));
            }

            seeds.push(seed);
        }

        this.fundedSeedPool = seeds;
        return seeds;
    }

    async fundedSeed(): Promise<string | undefined> {
        return this.fundedPool()[0];
    }

    async fundedSeeds(limit = 32): Promise<{ seeds: string[]; count: number }> {
        const pool = this.fundedPool();

        return { seeds: pool.slice(0, Math.max(0, limit)), count: pool.length };
    }

    async putContractSource(slot: number, source: string): Promise<boolean> {
        this.sim.assertOperational();
        this.contractSources.set(slot, source);
        return true;
    }

    async balance(id: string | Uint8Array): Promise<EntityInfo> {
        const bytes = this.idToBytes(id);
        const entity = this.sim.getEntity(bytes);

        return {
            id: typeof id === "string" ? id : await bytesToIdentity(bytes),
            balance: this.sim.balance(bytes).toString(),
            incomingAmount: (entity?.incomingAmount ?? 0n).toString(),
            outgoingAmount: (entity?.outgoingAmount ?? 0n).toString(),
            numberOfIncomingTransfers: entity?.numberOfIncomingTransfers ?? 0,
            numberOfOutgoingTransfers: entity?.numberOfOutgoingTransfers ?? 0,
            latestIncomingTransferTick: entity?.latestIncomingTransferTick ?? 0,
            latestOutgoingTransferTick: entity?.latestOutgoingTransferTick ?? 0,
        };
    }

    async tickTransactions(tick: number): Promise<TxInfo[]> {
        return this.sim.tickTransactions(tick).map((transaction) => ({
            txId: transaction.txId,
            tick: transaction.tick,
            source: transaction.source,
            dest: transaction.dest,
            amount: transaction.amount.toString(),
            inputType: transaction.inputType,
            moneyFlew: transaction.moneyFlew,
        }));
    }

    async seedFaucet(amount = 1000000000000n): Promise<void> {
        this.sim.assertOperational();
        for (const seed of this.fundedPool()) {
            this.sim.fund(deriveKeysSync(seed).publicKey, amount);
        }
    }

    fund(id: string | Uint8Array, amount: bigint): void {
        this.sim.assertOperational();
        this.sim.fund(this.idToBytes(id), amount);
    }

    rawTx(digestHex: string): Uint8Array | undefined {
        const stored = this.rawTransactions.get(digestHex);
        if (!stored) {
            return undefined;
        }

        if (this.sim.isFaulted()) {
            const transaction = this.sim.txByHash(stored.txId);
            if (!transaction || transaction.tick > this.sim.finalizedTick()) {
                return undefined;
            }
        }

        return stored.bytes;
    }

    // Public because the explorer read models resolve identities through the same rules.
    idToBytes(id: string | Uint8Array): Uint8Array {
        if (id instanceof Uint8Array) {
            return id;
        }
        if (/^[0-9a-fA-F]{64}$/.test(id)) {
            return hexToBytes(id);
        }

        return identityToBytes(id);
    }
}
