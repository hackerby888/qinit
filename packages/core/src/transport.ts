// NodeTransport — the seam between qinit and a node backend. The HTTP client (LiteRpc) and the in-process
// TS engine (@qinit/engine InProcessEngine) both implement it, so qinit's deploy/test/call flows run against
// either. This is the subset of the node RPC surface qinit actually depends on. broadcastTx is folded in:
// it is a free function in net.ts (not a LiteRpc method today), but it is part of the surface a backend must
// answer, so the interface owns it.
import type { TickInfo, DynRegistry, DynUpload, DebugTrace } from "./rpc";
import type { BroadcastResult } from "./net";

export interface TxStatus {
  tick: number; currentTick: number; txId: string; found: boolean; moneyFlew: boolean; processed: boolean;
}
export interface StateRead { off: number; len: number; stateSize: number; hex: string; }

// Spectrum entity (balances). Amounts are strings (i64 may exceed JS number / cross JSON).
export interface EntityInfo {
  id: string;
  balance: string;
  incomingAmount: string;
  outgoingAmount: string;
  numberOfIncomingTransfers: number;
  numberOfOutgoingTransfers: number;
  latestIncomingTransferTick: number;
  latestOutgoingTransferTick: number;
}

// A transaction recorded in a tick (lite tickdata). source/dest are hex ids; amount is a string.
export interface TxInfo {
  txId: string;
  tick: number;
  source: string;
  dest: string;
  amount: string;
  inputType: number;
  moneyFlew: boolean;
}

export interface NodeTransport {
  tickInfo(): Promise<TickInfo>;
  dynRegistry(): Promise<DynRegistry>;
  dynUpload(): Promise<DynUpload>;
  txStatus(tick: number, txId: string): Promise<TxStatus>;
  querySmartContract(contractIndex: number, inputType: number, input: Uint8Array): Promise<Uint8Array>;
  broadcastTx(txBytes: Uint8Array): Promise<BroadcastResult>;
  debugTrace(since?: number, limit?: number): Promise<DebugTrace>;
  setDebug(on: boolean): Promise<{ enabled: boolean }>;
  stateRead(slot: number, off: number, len: number): Promise<StateRead>;
  fundedSeed(): Promise<string | undefined>;
  putContractSource(slot: number, source: string): Promise<boolean>;
  balance(id: string): Promise<EntityInfo>;
  tickTransactions(tick: number): Promise<TxInfo[]>;
}
