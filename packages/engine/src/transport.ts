// Layer 3 — NodeTransport adapter. Implements the qinit RPC surface (@qinit/core NodeTransport) on top of the
// in-process engine (Sim + Contract), so qinit's deploy/test/call flows can target the TS engine instead of
// an HTTP node. Deploy works two ways: deploy() (direct, for the IDE) and the on-chain
// UPLOAD_BEGIN/CHUNK/DEPLOY wire protocol via broadcastTx (drop-in for qinit's deploy-ops).
import type {
  NodeTransport, TxStatus, StateRead, TickInfo, DynRegistry, DynContract, DynEntry, DynUpload, DebugTrace, BroadcastResult,
} from "@qinit/core";
import { LITE_TX, CHUNK_DATA_MAX } from "@qinit/proto";
import { Sim } from "./sim";
import { Contract, KIND } from "./runtime";
import { k12Bytes, toHex } from "./k12";

interface SlotMeta { name: string; codeHash: string; version: number; }
interface UploadSession { sessionId: bigint; totalSize: number; chunkCount: number; buf: Uint8Array; received: Set<number>; finalHash: string; }

export class InProcessEngine implements NodeTransport {
  readonly sim = new Sim();
  readonly slotBase: number;
  readonly slotCount: number;
  private meta = new Map<number, SlotMeta>();
  private upload: UploadSession | null = null;

  constructor(opts: { slotBase?: number; slotCount?: number } = {}) {
    this.slotBase = opts.slotBase ?? 28;
    this.slotCount = opts.slotCount ?? 4;
  }

  // Direct deploy (IDE / tests): bypass the chunk protocol — load wasm into the slot + construct (INITIALIZE).
  deploy(slot: number, wasm: Uint8Array, name = "Contract"): Contract {
    const c = this.sim.deploy(slot, wasm);
    this.meta.set(slot, { name, codeHash: toHex(k12Bytes(wasm)), version: (this.meta.get(slot)?.version ?? 0) + 1 });
    return c;
  }

  // Advance the chain n ticks (BEGIN_TICK asc -> END_TICK desc each). The IDE/test drives time explicitly.
  advanceTick(n = 1): number {
    for (let i = 0; i < n; i++) {
      this.sim.beginTick();
      this.sim.endTick();
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
      contracts.push({ index: s, armed: true, constructed: true, version: m.version, name: m.name, codeHash: m.codeHash, functions: pick(KIND.FUNCTION), procedures: pick(KIND.PROCEDURE) });
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
    return { tick, currentTick: this.sim.tickN, txId, found: true, moneyFlew: false, processed: true };
  }

  async querySmartContract(contractIndex: number, inputType: number, input: Uint8Array): Promise<Uint8Array> {
    return this.sim.query(contractIndex, inputType, input); // function call (kind=0)
  }

  // Decode a signed tx and route it: dest==99999 -> deploy wire protocol; else -> contract procedure. The
  // signature is NOT verified (consensus simplified, no security). Layout = canonical Qubic tx:
  // src[32] dest[32] amount[8] tick[4] inputType[2] inputSize[2] payload[inputSize] sig[64].
  async broadcastTx(txBytes: Uint8Array): Promise<BroadcastResult> {
    try {
      const v = new DataView(txBytes.buffer, txBytes.byteOffset, txBytes.byteLength);
      const dest = v.getBigUint64(32, true);
      const inputType = v.getUint16(76, true);
      const inputSize = v.getUint16(78, true);
      const payload = txBytes.slice(80, 80 + inputSize);
      if (dest === 99999n) this.handleDeployTx(inputType, payload);
      else this.sim.procedure(Number(dest), inputType, payload);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
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
    return { enabled: false, entries: [] };
  }

  async setDebug(on: boolean): Promise<{ enabled: boolean }> {
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

  async putContractSource(_slot: number, _source: string): Promise<boolean> {
    return true;
  }
}
