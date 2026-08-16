// Stores per-tick transaction history, transaction IDs, and the scheduled mempool.
import type { Id } from "../support/bytes";

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

// A broadcast tx awaiting its scheduled tick (mempool mode). Holds the decoded processTickTransaction arguments.
export interface QueuedTx {
    source: Id;
    dest: Id;
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
    private knownIds = new Set<string>();

    has(txId: string): boolean {
        return this.knownIds.has(txId);
    }

    // Record an applied tx under its tick (and by id).
    record(r: TxRecord): void {
        if (this.byId.has(r.txId)) {
            throw new Error(`duplicate transaction ${r.txId}`);
        }

        let list = this.byTick.get(r.tick);
        if (!list) {
            list = [];
            this.byTick.set(r.tick, list);
        }

        list.push(r);
        this.byId.set(r.txId, r);
        this.knownIds.add(r.txId);
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
        if (this.knownIds.has(tx.txId)) {
            throw new Error(`duplicate transaction ${tx.txId}`);
        }

        let q = this.mempool.get(scheduledTick);
        if (!q) {
            q = [];
            this.mempool.set(scheduledTick, q);
        }

        q.push(tx);
        this.knownIds.add(tx.txId);
    }

    // The number of txs scheduled for `tick` still in the mempool — peeked without draining. The tick's pending
    // tx-set size, read at the start of the tick as qpi numberOfTickTransactions.
    dueCount(tick: number): number {
        return this.mempool.get(tick)?.length ?? 0;
    }

    // Queued-but-unapplied counts per scheduled tick, oldest first — the explorer's mempool view.
    pendingByTick(): { tick: number; count: number }[] {
        return [...this.mempool].map(([tick, queued]) => ({ tick, count: queued.length })).sort((a, b) => a.tick - b.tick);
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

    pruneFinalized(finalizedTick: number, historyTicks: number): string[] {
        const firstRetainedTick = finalizedTick - Math.max(1, historyTicks) + 1;
        const removedIds: string[] = [];

        for (const [tick, records] of this.byTick) {
            if (tick >= firstRetainedTick) {
                continue;
            }

            this.byTick.delete(tick);
            for (const record of records) {
                this.byId.delete(record.txId);
                this.knownIds.delete(record.txId);
                removedIds.push(record.txId);
            }
        }

        return removedIds;
    }
}
