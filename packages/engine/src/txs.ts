// Transaction storage — the per-tick tx history + tx-by-id index, plus the mempool of broadcast txs awaiting
// their scheduled tick (the lite analogue of core-lite's tick_storage + pending-transaction pool). Pure storage

export interface TxRecord {
  txId: string;
  tick: number;
  source: string; // hex id
  dest: string; // hex id
  amount: bigint;
  inputType: number;
  moneyFlew: boolean;
  digest: Uint8Array; // K12(full signed tx) — the tick's TickData transactionDigests entry
}

// A broadcast tx awaiting its scheduled tick (mempool mode). Holds the decoded applyTx arguments.
export interface QueuedTx {
  source: Uint8Array;
  dest: Uint8Array;
  amount: bigint;
  inputType: number;
  payload: Uint8Array;
  txId: string;
  digest: Uint8Array; // K12(full signed tx)
}

export class TxPool {
  private byTick = new Map<number, TxRecord[]>();
  private byId = new Map<string, TxRecord>();
  private mempool = new Map<number, QueuedTx[]>(); // scheduled tick -> txs awaiting that tick

  // Record an applied tx under its tick (and by id).
  record(r: TxRecord): void {
    let list = this.byTick.get(r.tick);
    if (!list) {
      list = [];
      this.byTick.set(r.tick, list);
    }

    list.push(r);
    this.byId.set(r.txId, r);
  }

  tickTransactions(tick: number): TxRecord[] {
    return this.byTick.get(tick) ?? [];
  }

  txByHash(txId: string): TxRecord | undefined {
    return this.byId.get(txId);
  }

  get size(): number {
    return this.byId.size;
  }

  // Hold a broadcast tx until the chain reaches its scheduled tick (mempool mode).
  queue(scheduledTick: number, tx: QueuedTx): void {
    let q = this.mempool.get(scheduledTick);
    if (!q) {
      q = [];
      this.mempool.set(scheduledTick, q);
    }

    q.push(tx);
  }

  // The number of txs scheduled for `tick` still in the mempool — peeked without draining. The tick's pending
  // tx-set size, read at the start of the tick as qpi numberOfTickTransactions.
  dueCount(tick: number): number {
    return this.mempool.get(tick)?.length ?? 0;
  }

  // Remove + return the txs scheduled for `tick` (drained by the orchestrator each advance).
  takeDue(tick: number): QueuedTx[] {
    const q = this.mempool.get(tick);
    if (!q) {
      return [];
    }

    this.mempool.delete(tick);
    return q;
  }
}
