// Layer 3 — NodeTransport adapter. Implements the qinit RPC surface (@qinit/core NodeTransport) on top of the
// in-process engine (Sim + Contract), so qinit's deploy/test/call flows can target the TS engine instead of
// an HTTP node. Deploy works two ways: deploy() (direct, for the IDE) and the on-chain
// UPLOAD_BEGIN/CHUNK/DEPLOY wire protocol via broadcastTx (drop-in for qinit's deploy-ops).
import type {
  NodeTransport, TxStatus, StateRead, TickInfo, DynRegistry, DynContract, DynEntry, DynUpload, DebugTrace, BroadcastResult, EntityInfo, TxInfo,
} from "@qinit/core";
import { bytesToIdentity, identityToBytes, deriveIdentity } from "@qinit/core";
import { LITE_TX, CHUNK_DATA_MAX } from "@qinit/proto";
import { Sim, type AssetSnapshot } from "./sim";
import type { CommitteeOpts } from "./consensus";
import { Contract, KIND } from "./runtime";
import { k12Bytes, toHex } from "./k12";

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

  constructor(opts: { slotBase?: number; slotCount?: number; consensus?: CommitteeOpts; mempool?: boolean } = {}) {
    this.sim = new Sim({ consensus: opts.consensus, mempool: opts.mempool });
    this.slotBase = opts.slotBase ?? 28;
    this.slotCount = opts.slotCount ?? 4;
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

  async tickInfo(): Promise<TickInfo> {
    return { tick: this.sim.tickN, epoch: this.sim.epochN };
  }

  async dynRegistry(): Promise<DynRegistry> {
    const contracts: DynContract[] = [];
    for (let s = this.slotBase; s < this.slotBase + this.slotCount; s++) {
      const c = this.sim.contracts.get(s);
      const m = this.meta.get(s);
      if (!c || !m) {
        contracts.push({ index: s, armed: false, constructed: false, version: 0, name: "", codeHash: "", functions: [], procedures: [] });
        continue;
      }
      const pick = (kind: number): DynEntry[] =>
        c.entries.filter((e) => e.kind === kind).map((e) => ({ inputType: e.it, inputSize: e.inSize, outputSize: e.outSize }));
      contracts.push({ index: s, armed: true, constructed: true, version: m.version, name: m.name, codeHash: m.codeHash, functions: pick(KIND.FUNCTION), procedures: pick(KIND.PROCEDURE), source: this.sources.get(s) });
    }
    return { contracts, slotBase: this.slotBase, slotCount: this.slotCount };
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
      const v = new DataView(txBytes.buffer, txBytes.byteOffset, txBytes.byteLength);
      const source = txBytes.slice(0, 32);
      const destBytes = txBytes.slice(32, 64);
      const destLo = v.getBigUint64(32, true);
      const amount = v.getBigInt64(64, true);
      const txTick = v.getUint32(72, true);
      const inputType = v.getUint16(76, true);
      const inputSize = v.getUint16(78, true);
      const payload = txBytes.slice(80, 80 + inputSize);

      if (destLo === 99999n) {
        this.handleDeployTx(inputType, payload);
        return { ok: true };
      }

      const body = txBytes.length > 64 ? txBytes.slice(0, txBytes.length - 64) : txBytes;
      const txId = await this.txId(txBytes);
      // Index the raw tx by every digest the peer protocol might query by: K12(body, no sig) = qinit's txId,
      // K12(full tx incl. sig) = the protocol tx hash, and the txId string (REQUEST_TICK_TRANSACTIONS).
      this.rawTxs.set(toHex(k12Bytes(body)), txBytes);
      this.rawTxs.set(toHex(k12Bytes(txBytes)), txBytes);
      this.rawTxs.set(txId, txBytes);
      this.sim.enqueueTx(txTick, source, destBytes, amount, inputType, payload, txId);
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

  async fundedSeed(): Promise<string | undefined> {
    return "a".repeat(55);
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

  // Pre-fund the funded-seed identity so regular txs from seed accounts have balance (faucet).
  async seedFaucet(amount = 1000000000000n): Promise<void> {
    const { publicKeyHex } = await deriveIdentity("a".repeat(55));
    this.sim.fund(hexToBytes(publicKeyHex), amount);
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
