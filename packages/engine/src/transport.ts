// Layer 3 — NodeTransport adapter. Implements the qinit RPC surface (@qinit/core NodeTransport) on top of the
// in-process engine (Sim + Contract), so qinit's deploy/test/call flows can target the TS engine instead of
// an HTTP node. Deploy works two ways: deploy() (direct, for the IDE) and the on-chain
// UPLOAD_BEGIN/CHUNK/DEPLOY wire protocol via broadcastTx (drop-in for qinit's deploy-ops).
import type {
  NodeTransport, TxStatus, StateRead, TickInfo, DynRegistry, DynContract, DynEntry, DynUpload, DebugTrace, BroadcastResult, EntityInfo, TxInfo,
} from "@qinit/core";
import { bytesToIdentity, identityToBytes } from "@qinit/core";
import { LITE_TX, CHUNK_DATA_MAX } from "@qinit/proto";
import { Sim, type AssetSnapshot, type FeeMode } from "./sim";
import type { CommitteeOpts } from "./consensus";
import { Contract, KIND } from "./runtime";
import { k12Bytes, toHex, verifySync, deriveKeysSync } from "./k12";
import { Transaction } from "./wire";

interface SlotMeta { name: string; codeHash: string; version: number; }
interface UploadSession { sessionId: bigint; totalSize: number; chunkCount: number; buf: Uint8Array; received: Set<number>; finalHash: string; }

export class InProcessEngine implements NodeTransport {
  readonly sim: Sim;
  readonly slotBase: number;
  readonly slotCount: number;
  private meta = new Map<number, SlotMeta>();
  private upload: UploadSession | null = null;
  private sources = new Map<number, string>(); // deployed .h source per slot (for callee auto-resolution)
  private rawTxs = new Map<string, Uint8Array>(); // hex(K12(tx body)) -> raw tx bytes (peer REQUEST_TRANSACTION_INFO)
  private _pool: string[] | null = null; // memoized funded-seed pool (see fundedPool)
  private static readonly POOL_SIZE = 16; // funded dev seeds the virtual node exposes via /dev/funded-seeds

  private verifySigs: boolean;

  // `fees`/`mempool`/`verifySigs` are all off by default — the engine behaves exactly as before (no fee gating,
  // immediate apply, no signature check) so the IDE and its digests are unchanged. The peer entry opts in.
  constructor(opts: { slotBase?: number; slotCount?: number; consensus?: CommitteeOpts; mempool?: boolean; verifySigs?: boolean; fees?: FeeMode; defaultReserve?: bigint } = {}) {
    this.sim = new Sim({ consensus: opts.consensus, mempool: opts.mempool, fees: opts.fees, defaultReserve: opts.defaultReserve });
    this.slotBase = opts.slotBase ?? 28;
    this.slotCount = opts.slotCount ?? 4;
    this.verifySigs = opts.verifySigs ?? false;
  }

  // Execution-fee reserve controls (no-ops on behaviour when fees are "off"; see Sim).
  feeReserve(slot: number): bigint {
    return this.sim.feeReserveOf(slot);
  }

  setFeeReserve(slot: number, amount: bigint): void {
    this.sim.setFeeReserve(slot, amount);
  }

  ipo(slot: number, finalPrice: bigint): void {
    this.sim.ipo(slot, finalPrice);
  }

  // Direct deploy (IDE / tests): bypass the chunk protocol — load wasm into the slot + construct (INITIALIZE).
  deploy(slot: number, wasm: Uint8Array, name = "Contract"): Contract {
    const c = this.sim.deploy(slot, wasm);
    this.meta.set(slot, { name, codeHash: toHex(k12Bytes(wasm)), version: (this.meta.get(slot)?.version ?? 0) + 1 });
    return c;
  }

  // Advance the chain n ticks (each: epoch switch on a boundary, then BEGIN_TICK asc -> END_TICK desc). The
  // IDE/test drives time explicitly.
  advanceTick(n = 1): number {
    for (let i = 0; i < n; i++) {
      this.sim.advance();
    }
    return this.sim.tickN;
  }

  // Current-epoch tick window (the node's /live/v1/dev/epoch-info). Sim switches epoch when (tickN+1) crosses a
  // multiple of epochLength, so epoch k spans ticks [k·L, (k+1)·L − 1].
  epochInfo(): { epoch: number; tick: number; initialTick: number; epochLastTick: number; ticksLeft: number; duration: number } {
    const L = this.sim.epochLength;
    const tick = this.sim.tickN;
    const epoch = this.sim.epochN;
    const initialTick = L > 0 ? epoch * L : 0;
    const epochLastTick = L > 0 ? (epoch + 1) * L - 1 : tick;
    return { epoch, tick, initialTick, epochLastTick, ticksLeft: Math.max(0, epochLastTick - tick), duration: L };
  }

  // Advance up to n ticks, capped at the epoch's last tick (tick-advance never crosses an epoch; use advanceEpoch).
  advanceTickN(n: number): { from: number; requested: number; target: number; reached: number; epochLastTick: number; cappedAtEpochEnd: boolean } {
    const from = this.sim.tickN;
    const epochLastTick = this.epochInfo().epochLastTick;
    const target = Math.min(from + Math.max(0, n), epochLastTick);
    this.advanceTick(Math.max(0, target - from));
    return { from, requested: n, target, reached: this.sim.tickN, epochLastTick, cappedAtEpochEnd: from + n > epochLastTick };
  }

  // Advance to (epochLastTick − gap) — the pre-transition resting point.
  advanceToLast(gap = 3): { from: number; target: number; reached: number; epochLastTick: number; epoch: number } {
    const from = this.sim.tickN;
    const epochLastTick = this.epochInfo().epochLastTick;
    const target = Math.max(from, epochLastTick - Math.max(0, gap));
    this.advanceTick(Math.max(0, target - from));
    return { from, target, reached: this.sim.tickN, epochLastTick, epoch: this.sim.epochN };
  }

  // Cross into the next epoch: advance to the boundary tick, which triggers endEpoch/epochN++/beginEpoch.
  advanceEpoch(): { fromEpoch: number; toEpoch: number; fromTick: number; tick: number; initialTick: number; switched: boolean } {
    const fromEpoch = this.sim.epochN;
    const fromTick = this.sim.tickN;
    const L = this.sim.epochLength;
    if (L > 0) {
      // advance to the next tick that is a multiple of L (where Sim.advance switches the epoch) — derived from
      // tickN, not epochN, so it stays correct even if epochLength was changed mid-run.
      this.advanceTick((Math.floor(fromTick / L) + 1) * L - fromTick);
    }
    const toEpoch = this.sim.epochN;
    return { fromEpoch, toEpoch, fromTick, tick: this.sim.tickN, initialTick: L > 0 ? toEpoch * L : 0, switched: toEpoch > fromEpoch };
  }

  async tickInfo(): Promise<TickInfo> {
    return { tick: this.sim.tickN, epoch: this.sim.epochN };
  }

  async dynRegistry(): Promise<DynRegistry> {
    const contracts: DynContract[] = [];
    const armed = (s: number, c: Contract, m: SlotMeta): DynContract => {
      const pick = (kind: number): DynEntry[] =>
        c.entries.filter((e) => e.kind === kind).map((e) => ({ inputType: e.it, inputSize: e.inSize, outputSize: e.outSize }));
      return { index: s, armed: true, constructed: true, version: m.version, name: m.name, codeHash: m.codeHash, functions: pick(KIND.FUNCTION), procedures: pick(KIND.PROCEDURE), source: this.sources.get(s) };
    };
    for (let s = this.slotBase; s < this.slotBase + this.slotCount; s++) {
      const c = this.sim.contracts.get(s);
      const m = this.meta.get(s);
      if (!c || !m) {
        contracts.push({ index: s, armed: false, constructed: false, version: 0, name: "", codeHash: "", functions: [], procedures: [] });
        continue;
      }
      contracts.push(armed(s, c, m));
    }
    // Contracts deployed outside the user window — seeded system contracts (direct-deploy) — so ls / system ls
    // reflect the node.
    for (const [s, c] of this.sim.contracts) {
      if (s >= this.slotBase && s < this.slotBase + this.slotCount) continue;
      const m = this.meta.get(s);
      if (m) contracts.push(armed(s, c, m));
    }
    contracts.sort((a, b) => a.index - b.index);
    return { contracts, slotBase: this.slotBase, slotCount: this.slotCount };
  }

  // Remove a deployed contract (dev `qinit system rm`).
  undeploy(slot: number): boolean {
    this.meta.delete(slot);
    this.sources.delete(slot);
    return this.sim.undeploy(slot);
  }

  async dynUpload(): Promise<DynUpload> {
    const u = this.upload;
    if (!u) {
      return { active: false, sessionId: "0", totalSize: 0, chunkSize: CHUNK_DATA_MAX, chunkCount: 0, receivedCount: 0, complete: false, finalHash: "", missing: [], missingCount: 0 };
    }
    const missing: number[] = [];
    for (let i = 0; i < u.chunkCount; i++) {
      if (!u.received.has(i)) missing.push(i);
    }
    return { active: true, sessionId: u.sessionId.toString(), totalSize: u.totalSize, chunkSize: CHUNK_DATA_MAX, chunkCount: u.chunkCount, receivedCount: u.received.size, complete: missing.length === 0, finalHash: u.finalHash, missing, missingCount: missing.length };
  }

  async txStatus(tick: number, txId: string): Promise<TxStatus> {
    // Single-authority engine: every broadcast tx is included + processed. moneyFlew is best-effort (the
    // engine's tickdata txId is K12(tx)->identity; qinit's tx.id may differ, so an unknown id defaults true).
    const r = this.sim.txByHash(txId);
    return { tick, currentTick: this.sim.tickN, txId, found: true, moneyFlew: r?.moneyFlew ?? true, processed: true };
  }

  async querySmartContract(contractIndex: number, inputType: number, input: Uint8Array): Promise<Uint8Array> {
    return this.sim.query(contractIndex, inputType, input); // function call (kind=0)
  }

  // Decode a signed tx and dispatch it faithfully (qubic.cpp processTickTransaction). The signature is NOT
  // verified (consensus simplified). Layout = src[32] dest[32] amount[8] tick[4] inputType[2] inputSize[2]
  // payload[inputSize] sig[64]. dest==99999 -> deploy wire protocol; otherwise sim.applyTx routes by
  // (destination, inputType): a contract procedure (registered inputType), a plain transfer to a contract, or a
  // regular user-to-user transfer.
  async broadcastTx(txBytes: Uint8Array): Promise<BroadcastResult> {
    try {
      const tx = Transaction.wrap(txBytes);
      const source = tx.sourcePublicKey.bytes.slice();
      const destBytes = tx.destinationPublicKey.bytes.slice();
      const destLo = tx.destinationPublicKey.u64(0);
      const amount = tx.amount;
      const txTick = tx.tick;
      const inputType = tx.inputType;
      const payload = tx.input.slice();

      if (destLo === 99999n) {
        this.handleDeployTx(inputType, payload);
        return { ok: true };
      }

      const body = txBytes.length > 64 ? txBytes.slice(0, txBytes.length - 64) : txBytes;

      // A real node rejects a tx whose FourQ signature does not match its source (opt-in). The signature
      // covers K12(tx − signature); the source public key is the first 32 bytes.
      if (this.verifySigs) {
        const sig = txBytes.subarray(txBytes.length - 64);
        if (txBytes.length <= 64 || !verifySync(source, k12Bytes(body), sig)) {
          return { ok: false, message: "invalid signature" };
        }
      }

      const txId = await this.txId(txBytes);
      const fullDigest = k12Bytes(txBytes); // K12(full tx incl. sig) — the TickData transactionDigests entry
      // Index the raw tx by every digest the peer protocol might query by: K12(body, no sig) = qinit's txId,
      // K12(full tx incl. sig) = the protocol tx hash, and the txId string (REQUEST_TICK_TRANSACTIONS).
      this.rawTxs.set(toHex(k12Bytes(body)), txBytes);
      this.rawTxs.set(toHex(fullDigest), txBytes);
      this.rawTxs.set(txId, txBytes);
      this.sim.enqueueTx(txTick, source, destBytes, amount, inputType, payload, txId, fullDigest);
      return { ok: true, transactionId: txId };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  }

  // Transaction id = identity(K12(tx without its 64-byte signature)) — matches qinit's buildSignedTx tx.id.
  private async txId(txBytes: Uint8Array): Promise<string> {
    const body = txBytes.length > 64 ? txBytes.slice(0, txBytes.length - 64) : txBytes;
    return bytesToIdentity(k12Bytes(body));
  }

  // UPLOAD_BEGIN / UPLOAD_CHUNK / DEPLOY — mirrors core-lite lite_dynamic_contracts.h LE decode + the proto
  // encoders (packages/proto/src/deploy.ts).
  private handleDeployTx(inputType: number, p: Uint8Array): void {
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (inputType === LITE_TX.UPLOAD_BEGIN) {
      const totalSize = v.getUint32(8, true);
      this.upload = { sessionId: v.getBigUint64(0, true), totalSize, chunkCount: v.getUint32(12, true), buf: new Uint8Array(totalSize), received: new Set(), finalHash: toHex(p.slice(16, 48)) };
    } else if (inputType === LITE_TX.UPLOAD_CHUNK) {
      const u = this.upload;
      if (!u) throw new Error("upload chunk without an active session");
      const seq = v.getUint32(8, true);
      const len = v.getUint16(12, true);
      u.buf.set(p.slice(14, 14 + len), seq * CHUNK_DATA_MAX);
      u.received.add(seq);
    } else if (inputType === LITE_TX.DEPLOY) {
      const u = this.upload;
      if (!u) throw new Error("deploy without an active session");
      const targetSlot = v.getUint32(8, true);
      const raw = p.length >= 84 ? new TextDecoder().decode(p.slice(52, 84)) : "";
      const name = raw.replace(/[^\x20-\x7e].*$/, "") || "Contract"; // strip the null pad
      this.deploy(targetSlot, u.buf, name);
      this.upload = null;
    } else {
      throw new Error("unknown deploy-range inputType " + inputType);
    }
  }

  async debugTrace(): Promise<DebugTrace> {
    return this.sim.getTrace();
  }

  // Read-only snapshot of the asset universe (issued assets + share holdings) — the IDE assets inspector.
  assetUniverse(): AssetSnapshot[] {
    return this.sim.assetUniverse();
  }

  async setDebug(on: boolean): Promise<{ enabled: boolean }> {
    this.sim.setDebug(on);
    return { enabled: on };
  }

  async stateRead(slot: number, off: number, len: number): Promise<StateRead> {
    const c = this.sim.contracts.get(slot);
    const st = c ? c.state() : new Uint8Array(0);
    return { off, len, stateSize: st.length, hex: toHex(st.slice(off, off + len)) };
  }

  // Deterministic, reproducible pool of funded dev seeds — mirrors the real node, whose /dev/funded-seeds
  // returns its (funded) computor seeds. pool[0] is the universal default "a"*55 that every command falls back
  // to; the rest are derived from K12 so the identities are stable across restarts. Built lazily (needs initK12).
  fundedPool(): string[] {
    if (this._pool) {
      return this._pool;
    }
    const enc = new TextEncoder();
    const seeds = ["a".repeat(55)];
    for (let i = 1; i < InProcessEngine.POOL_SIZE; i++) {
      const bytes = [...k12Bytes(enc.encode("qinit/funded-seed/" + i)), ...k12Bytes(enc.encode("qinit/funded-seed/" + i + "#"))];
      let s = "";
      for (let j = 0; j < 55; j++) {
        s += String.fromCharCode(97 + (bytes[j] % 26)); // map each byte into a-z -> a valid 55-letter seed
      }
      seeds.push(s);
    }
    this._pool = seeds;
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
    this.sources.set(slot, source);
    return true;
  }

  // ---- regular txs / spectrum / tickdata ----
  async balance(id: string): Promise<EntityInfo> {
    const bytes = this.idToBytes(id);
    const e = this.sim.entityOf(bytes);

    return {
      id,
      balance: this.sim.balance(bytes).toString(),
      incomingAmount: (e?.incomingAmount ?? 0n).toString(),
      outgoingAmount: (e?.outgoingAmount ?? 0n).toString(),
      numberOfIncomingTransfers: e?.numberOfIncomingTransfers ?? 0,
      numberOfOutgoingTransfers: e?.numberOfOutgoingTransfers ?? 0,
      latestIncomingTransferTick: e?.latestIncomingTransferTick ?? 0,
      latestOutgoingTransferTick: e?.latestOutgoingTransferTick ?? 0,
    };
  }

  async tickTransactions(tick: number): Promise<TxInfo[]> {
    return this.sim.tickTransactions(tick).map((r) => ({
      txId: r.txId,
      tick: r.tick,
      source: r.source,
      dest: r.dest,
      amount: r.amount.toString(),
      inputType: r.inputType,
      moneyFlew: r.moneyFlew,
    }));
  }

  // Pre-fund every funded-pool identity so regular txs from any picked seed have balance (faucet).
  async seedFaucet(amount = 1000000000000n): Promise<void> {
    for (const seed of this.fundedPool()) {
      this.sim.fund(deriveKeysSync(seed).publicKey, amount);
    }
  }

  // Credit an identity directly (tests / IDE faucet).
  fund(id: Uint8Array, amount: bigint): void {
    this.sim.fund(id, amount);
  }

  // The raw bytes of a broadcast tx, keyed by hex(K12(tx body)) — the digest the peer REQUEST_TRANSACTION_INFO
  // queries by. Undefined if never seen.
  rawTx(digestHex: string): Uint8Array | undefined {
    return this.rawTxs.get(digestHex);
  }

  private idToBytes(id: string): Uint8Array {
    if (/^[0-9a-fA-F]{64}$/.test(id)) return hexToBytes(id);
    return identityToBytes(id); // 60-char identity
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
