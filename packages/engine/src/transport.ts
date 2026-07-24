import type {
  NodeTransport,
  TxStatus,
  StateRead,
  TickInfo,
  DynRegistry,
  DynContract,
  DynEntry,
  DynUpload,
  DebugTrace,
  BroadcastResult,
  EntityInfo,
  TxInfo,
} from "@qinit/core";
import {
  bytesToIdentity,
  identityToBytes,
  DEFAULT_WASM_SLOT_LAYOUT,
  WASM_ABI_VERSION,
} from "@qinit/core";
import {
  LITE_TX,
  CHUNK_DATA_MAX,
  UploadBegin,
  UploadChunkHeader,
  DeployMessage,
} from "@qinit/proto";
import {
  Sim,
  type AssetSnapshot,
  type FeeMode,
  type ProcedureOpts,
} from "./sim";
import type { LogSink } from "./log";
import type { CommitteeOpts } from "./consensus";
import { Contract, KIND } from "./runtime";
import {
  k12Bytes,
  toHex,
  verifySync,
  deriveKeysSync,
  initK12,
} from "./k12";
import { Transaction } from "./wire";
import { NativeLogger } from "./native-logger";

interface SlotMeta {
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
}

export interface EngineOpts {
  slotBase?: number;
  slotCount?: number;
  consensus?: CommitteeOpts;
  mempool?: boolean;
  verifySigs?: boolean;
  fees?: FeeMode;
  defaultReserve?: bigint;
  liteTicking?: boolean;
}

export class VirtualNode implements NodeTransport {
  readonly sim: Sim;
  readonly logger: NativeLogger;
  readonly slotBase: number;
  readonly slotCount: number;
  private slotMeta = new Map<number, SlotMeta>();
  private slotsByName = new Map<string, number>();
  private upload: UploadSession | null = null;
  private contractSources = new Map<number, string>();
  private rawTransactions = new Map<string, Uint8Array>();
  private fundedSeedPool: string[] | null = null;
  private static readonly FUNDED_POOL_SIZE = 16;

  private verifySignatures: boolean;

  get onLog(): LogSink | undefined {
    return this.sim.onLog;
  }

  set onLog(sink: LogSink | undefined) {
    this.sim.onLog = sink;
  }

  static async create(
    options: EngineOpts = {},
  ): Promise<VirtualNode> {
    await initK12();
    return new VirtualNode(options);
  }

  constructor(options: EngineOpts = {}) {
    this.logger = new NativeLogger();
    this.sim = new Sim({
      consensus: options.consensus,
      mempool: options.mempool ?? true,
      fees: options.fees ?? "metered",
      defaultReserve: options.defaultReserve,
      liteTicking: options.liteTicking,
      nativeLogger: this.logger,
    });
    this.slotBase =
      options.slotBase ?? DEFAULT_WASM_SLOT_LAYOUT.slotBase;
    this.slotCount =
      options.slotCount ?? DEFAULT_WASM_SLOT_LAYOUT.slotCount;
    this.verifySignatures = options.verifySigs ?? true;
  }

  feeReserve(slot: number): bigint {
    return this.sim.feeReserveOf(slot);
  }

  setFeeReserve(slot: number, amount: bigint): void {
    this.sim.setFeeReserve(slot, amount);
  }

  ipo(slot: number, finalPrice: bigint): void {
    this.sim.ipo(slot, finalPrice);
  }

  deploy(
    wasm: Uint8Array,
    options?: { name?: string; slot?: number; deployer?: Uint8Array },
  ): Contract;
  deploy(
    slot: number,
    wasm: Uint8Array,
    name?: string,
    deployer?: Uint8Array,
  ): Contract;
  deploy(
    slotOrWasm: number | Uint8Array,
    wasmOrOptions?:
      | Uint8Array
      | { name?: string; slot?: number; deployer?: Uint8Array },
    contractName?: string,
    contractDeployer?: Uint8Array,
  ): Contract {
    let wasm: Uint8Array;
    let name: string | undefined;
    let explicitSlot: number | undefined;
    let deployer: Uint8Array | undefined;

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
        }) ?? {};
      name = options.name;
      explicitSlot = options.slot;
      deployer = options.deployer;
    }

    const slot = this.resolveSlot(explicitSlot, name);
    const contract = this.sim.deploy(slot, wasm);
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
    this.sim.mintDeployShares(
      slot,
      ticker,
      deployer ?? this.sim.getCommittee().arbitrator.publicKey,
    );

    return contract;
  }

  private resolveSlot(
    explicitSlot: number | undefined,
    name: string | undefined,
  ): number {
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
    }

    return this.sim.tickN;
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
    const tick = this.sim.tickN;
    const epoch = this.sim.epochN;
    const initialTick = epochLength > 0 ? epoch * epochLength : 0;
    const epochLastTick =
      epochLength > 0 ? (epoch + 1) * epochLength - 1 : tick;

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
    const from = this.sim.tickN;
    const epochLastTick = this.epochInfo().epochLastTick;
    const target = Math.min(
      from + Math.max(0, count),
      epochLastTick,
    );

    this.advanceTick(Math.max(0, target - from));

    return {
      from,
      requested: count,
      target,
      reached: this.sim.tickN,
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
    const from = this.sim.tickN;
    const epochLastTick = this.epochInfo().epochLastTick;
    const target = Math.max(from, epochLastTick - Math.max(0, gap));

    this.advanceTick(Math.max(0, target - from));

    return {
      from,
      target,
      reached: this.sim.tickN,
      epochLastTick,
      epoch: this.sim.epochN,
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
    const fromEpoch = this.sim.epochN;
    const fromTick = this.sim.tickN;
    const epochLength = this.sim.epochLength;

    if (epochLength > 0) {
      const boundaryTick =
        (Math.floor(fromTick / epochLength) + 1) * epochLength;
      this.advanceTick(boundaryTick - fromTick);
    }

    const toEpoch = this.sim.epochN;

    return {
      fromEpoch,
      toEpoch,
      fromTick,
      tick: this.sim.tickN,
      initialTick: epochLength > 0 ? toEpoch * epochLength : 0,
      switched: toEpoch > fromEpoch,
    };
  }

  async tickInfo(): Promise<TickInfo> {
    return { tick: this.sim.tickN, epoch: this.sim.epochN };
  }

  async dynRegistry(): Promise<DynRegistry> {
    const contracts: DynContract[] = [];

    const deployedContract = (
      slot: number,
      contract: Contract,
      metadata: SlotMeta,
    ): DynContract => {
      const entries = (kind: number): DynEntry[] =>
        contract.entries
          .filter((entry) => entry.kind === kind)
          .map((entry) => ({
            inputType: entry.it,
            inputSize: entry.inSize,
            outputSize: entry.outSize,
          }));

      return {
        index: slot,
        armed: true,
        constructed: true,
        version: metadata.version,
        name: metadata.name,
        codeHash: metadata.codeHash,
        functions: entries(KIND.FUNCTION),
        procedures: entries(KIND.PROCEDURE),
        source: this.contractSources.get(slot),
      };
    };

    for (
      let slot = this.slotBase;
      slot < this.slotBase + this.slotCount;
      slot++
    ) {
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
      const isUserSlot =
        slot >= this.slotBase &&
        slot < this.slotBase + this.slotCount;
      if (isUserSlot) {
        continue;
      }

      const metadata = this.slotMeta.get(slot);
      if (metadata) {
        contracts.push(
          deployedContract(slot, contract, metadata),
        );
      }
    }

    contracts.sort((left, right) => left.index - right.index);

    return { contracts, slotBase: this.slotBase, slotCount: this.slotCount };
  }

  undeploy(slot: number): boolean {
    const name = this.slotMeta.get(slot)?.name;
    if (name !== undefined && this.slotsByName.get(name) === slot) {
    this.slotsByName.delete(name);
    }

    this.slotMeta.delete(slot);
    this.contractSources.delete(slot);

    return this.sim.undeploy(slot);
  }

  async dynUpload(): Promise<DynUpload> {
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
    };
  }

  async txStatus(tick: number, txId: string): Promise<TxStatus> {
    const transaction = this.sim.txByHash(txId);
    const processed = this.sim.tickN > tick;

    return {
      tick,
      currentTick: this.sim.tickN,
      txId,
      found: true,
      moneyFlew: transaction?.moneyFlew ?? true,
      processed,
    };
  }

  async querySmartContract(
    contractIndex: number,
    inputType: number,
    input: Uint8Array,
  ): Promise<Uint8Array> {
    return this.sim.query(contractIndex, inputType, input);
  }

  procedure(
    slot: number,
    inputType: number,
    input?: Uint8Array,
    options?: ProcedureOpts,
  ): Uint8Array {
    return this.sim.procedure(slot, inputType, input, options);
  }

  query(
    slot: number,
    inputType: number,
    input?: Uint8Array,
  ): Uint8Array {
    return this.sim.query(slot, inputType, input);
  }

  computerDigest(): Uint8Array {
    return this.sim.computerDigest();
  }

  spectrumDigest(): Uint8Array {
    return this.sim.spectrumDigest();
  }

  universeDigest(): Uint8Array {
    return this.sim.universeDigest();
  }

  async broadcastTx(txBytes: Uint8Array): Promise<BroadcastResult> {
    try {
      const transaction = Transaction.wrap(txBytes);
      const source = transaction.sourcePublicKey.bytes.slice();
      const destination =
        transaction.destinationPublicKey.bytes.slice();
      const destinationLane = transaction.destinationPublicKey.u64(0);
      const amount = transaction.amount;
      const scheduledTick = transaction.tick;
      const inputType = transaction.inputType;
      const payload = transaction.input.slice();

      if (destinationLane === 99999n) {
        this.handleDeployTx(inputType, payload, source);
        return { ok: true };
      }

      const body =
        txBytes.length > 64
          ? txBytes.slice(0, txBytes.length - 64)
          : txBytes;

      if (this.verifySignatures) {
        const signature = txBytes.subarray(txBytes.length - 64);
        const isValid =
          txBytes.length > 64 &&
          verifySync(source, k12Bytes(body), signature);

        if (!isValid) {
          return { ok: false, message: "invalid signature" };
        }
      }

      const txId = await this.txId(txBytes);
      const fullDigest = k12Bytes(txBytes);
      this.rawTransactions.set(toHex(k12Bytes(body)), txBytes);
      this.rawTransactions.set(toHex(fullDigest), txBytes);
      this.rawTransactions.set(txId, txBytes);

      const { moneyFlew, queued } = this.sim.enqueueTx(
        scheduledTick,
        source,
        destination,
        amount,
        inputType,
        payload,
        txId,
        fullDigest,
      );

      return { ok: true, transactionId: txId, moneyFlew, queued };
    } catch (error) {
      const message = String(
        (error as Error)?.message ?? error,
      );
      return { ok: false, message };
    }
  }

  private async txId(txBytes: Uint8Array): Promise<string> {
    const body =
      txBytes.length > 64
        ? txBytes.slice(0, txBytes.length - 64)
        : txBytes;

    return bytesToIdentity(k12Bytes(body));
  }

  private handleDeployTx(
    inputType: number,
    payload: Uint8Array,
    source?: Uint8Array,
  ): void {
    if (inputType === LITE_TX.UPLOAD_BEGIN) {
      const message = UploadBegin.wrap(payload);

      if (this.upload) {
        if (this.upload.sessionId !== message.sessionId) {
          throw new Error(
            `another contract upload is active (session ${this.upload.sessionId}, ${this.upload.received.size}/${this.upload.chunkCount} chunks); wait for it to complete`,
          );
        }

        return;
      }

      const totalSize = message.totalSize;
      this.upload = {
        sessionId: message.sessionId,
        totalSize,
        chunkCount: message.chunkCount,
        buf: new Uint8Array(totalSize),
        received: new Set(),
        finalHash: toHex(message.finalHash),
      };

      return;
    }

    if (inputType === LITE_TX.UPLOAD_CHUNK) {
      const upload = this.upload;
      if (!upload) {
        throw new Error("upload chunk without an active session");
      }

      const message = UploadChunkHeader.wrap(payload);
      if (message.sessionId !== upload.sessionId) {
        throw new Error("upload chunk for a different session");
      }

      upload.buf.set(
        payload.subarray(
          UploadChunkHeader.SIZE,
          UploadChunkHeader.SIZE + message.len,
        ),
        message.seq * CHUNK_DATA_MAX,
      );
      upload.received.add(message.seq);

      return;
    }

    if (inputType === LITE_TX.DEPLOY) {
      const upload = this.upload;
      if (!upload) {
        throw new Error("deploy without an active session");
      }

      const message = DeployMessage.wrap(payload);
      if (message.abiVersion !== WASM_ABI_VERSION) {
        throw new Error(
          `unsupported Wasm ABI version ${message.abiVersion}; expected ${WASM_ABI_VERSION}`,
        );
      }

      const rawName =
        payload.length >= DeployMessage.SIZE
          ? new TextDecoder().decode(message.name)
          : "";
      const name =
        rawName.replace(/[^\x20-\x7e].*$/, "") || "Contract";

      this.deploy(message.targetSlot, upload.buf, name, source);
      this.upload = null;

      return;
    }

    throw new Error("unknown deploy-range inputType " + inputType);
  }

  async debugTrace(): Promise<DebugTrace> {
    return this.sim.getTrace();
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

  async oracleResolve(
    queryId: bigint,
    reply: Uint8Array,
    status?: number,
  ): Promise<{ ok: boolean }> {
    return { ok: this.sim.resolveOracle(queryId, reply, status) };
  }

  async stateRead(
    slot: number,
    off: number,
    len: number,
  ): Promise<StateRead> {
    const contract = this.sim.contracts.get(slot);
    const state = contract ? contract.state() : new Uint8Array(0);

    return {
      off,
      len,
      stateSize: state.length,
      hex: toHex(state.slice(off, off + len)),
    };
  }

  fundedPool(): string[] {
    if (this.fundedSeedPool) {
      return this.fundedSeedPool;
    }
    const encoder = new TextEncoder();
    const seeds = ["a".repeat(55)];

    for (
      let seedIndex = 1;
      seedIndex < VirtualNode.FUNDED_POOL_SIZE;
      seedIndex++
    ) {
      const bytes = [
        ...k12Bytes(
          encoder.encode("qinit/funded-seed/" + seedIndex),
        ),
        ...k12Bytes(
          encoder.encode("qinit/funded-seed/" + seedIndex + "#"),
        ),
      ];

      let seed = "";
      for (let byteIndex = 0; byteIndex < 55; byteIndex++) {
        seed += String.fromCharCode(
          97 + (bytes[byteIndex] % 26),
        );
      }

      seeds.push(seed);
    }

    this.fundedSeedPool = seeds;
    return seeds;
  }

  async fundedSeed(): Promise<string | undefined> {
    return this.fundedPool()[0];
  }

  async fundedSeeds(
    limit = 32,
  ): Promise<{ seeds: string[]; count: number }> {
    const pool = this.fundedPool();

    return { seeds: pool.slice(0, Math.max(0, limit)), count: pool.length };
  }

  async putContractSource(slot: number, source: string): Promise<boolean> {
    this.contractSources.set(slot, source);
    return true;
  }

  async balance(id: string | Uint8Array): Promise<EntityInfo> {
    const bytes = this.idToBytes(id);
    const entity = this.sim.entityOf(bytes);

    return {
      id: typeof id === "string" ? id : await bytesToIdentity(bytes),
      balance: this.sim.balance(bytes).toString(),
      incomingAmount: (entity?.incomingAmount ?? 0n).toString(),
      outgoingAmount: (entity?.outgoingAmount ?? 0n).toString(),
      numberOfIncomingTransfers:
        entity?.numberOfIncomingTransfers ?? 0,
      numberOfOutgoingTransfers:
        entity?.numberOfOutgoingTransfers ?? 0,
      latestIncomingTransferTick:
        entity?.latestIncomingTransferTick ?? 0,
      latestOutgoingTransferTick:
        entity?.latestOutgoingTransferTick ?? 0,
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
    for (const seed of this.fundedPool()) {
      this.sim.fund(deriveKeysSync(seed).publicKey, amount);
    }
  }

  fund(id: string | Uint8Array, amount: bigint): void {
    this.sim.fund(this.idToBytes(id), amount);
  }

  rawTx(digestHex: string): Uint8Array | undefined {
    return this.rawTransactions.get(digestHex);
  }

  private idToBytes(id: string | Uint8Array): Uint8Array {
    if (id instanceof Uint8Array) {
      return id;
    }
    if (/^[0-9a-fA-F]{64}$/.test(id)) {
      return hexToBytes(id);
    }

    return identityToBytes(id);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(
      hex.slice(index * 2, index * 2 + 2),
      16,
    );
  }

  return bytes;
}
