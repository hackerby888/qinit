// The explorer read models. These mirror core-lite's /explorer/data and /query/v1/* response shapes so
// the TUI explorer can run against either backend without branching. Fields the simulator genuinely has
// no source for (peers, contract construction epochs) are reported as zeros rather than invented.
import type { ContractCallsPage, ContractListEntry, DynamicContractRegistry, ExplorerData, ExplorerTickData, ExplorerTx, IdentityTransfer } from "@qinit/core";
import { bytesToIdentity, hexToBytes } from "@qinit/core";
import type { QubicSimulator } from "./qubic-simulator";
import type { TxRecord } from "./chain/txs";
import { Transaction } from "./protocol/wire";
import { toHex } from "./support/k12";

// Ticks the explorer payload reaches back over — enough to fill a tall terminal, which windows the rest.
const RECENT_TICK_COUNT = 200;

// What the read models need from the node that owns them.
export interface ExplorerHost {
    readonly sim: QubicSimulator;
    epochInfo(): { tick: number; epoch: number; initialTick: number; epochLastTick: number };
    dynRegistry(): Promise<DynamicContractRegistry>;
    rawTx(digestHex: string): Uint8Array | undefined;
    idToBytes(id: string | Uint8Array): Uint8Array;
}

export class ExplorerReadModel {
    constructor(private readonly node: ExplorerHost) {}

    private get sim() {
        return this.node.sim;
    }

    // Tick timestamp as unix seconds, matching core's formatTimestamp. "" when the tick has no TickData.
    private tickTimestamp(tick: number): string {
        const td = this.sim.tickData(tick);
        if (!td) {
            return "";
        }

        const ms = Date.UTC(2000 + td.year, td.month - 1, td.day, td.hour, td.minute, td.second, td.millisecond);
        return String(Math.floor(ms / 1000));
    }

    // A recorded tx in core's transactionToJson shape. inputSize/inputData/signature come from the stored raw
    // bytes; a tx applied directly (no broadcast) has none, so those stay empty instead of being faked.
    private async tx(record: TxRecord): Promise<ExplorerTx> {
        const raw = this.node.rawTx(record.txId);
        let inputSize = 0;
        let inputData = "";
        let signature = "";

        if (raw) {
            const transaction = Transaction.wrap(raw);
            inputSize = transaction.inputSize;
            inputData = Buffer.from(transaction.input).toString("base64");
            signature = Buffer.from(transaction.signature).toString("base64");
        }

        return {
            hash: record.txId,
            amount: record.amount.toString(),
            source: await bytesToIdentity(hexToBytes(record.source)),
            destination: await bytesToIdentity(hexToBytes(record.dest)),
            tickNumber: record.tick,
            timestamp: this.tickTimestamp(record.tick),
            inputType: record.inputType,
            inputSize,
            inputData,
            signature,
            moneyFlew: record.moneyFlew,
        };
    }

    async data(): Promise<ExplorerData> {
        const { tick, epoch, initialTick } = this.node.epochInfo();
        const committee = this.sim.getCommittee();
        const pending = this.sim.mempoolCounts();
        const spectrum = this.sim.spectrumInfo();

        // Never reach past the retained history: a pruned tick has no record left and would be reported as an
        // empty tick rather than as one the node no longer remembers.
        const reach = Math.min(RECENT_TICK_COUNT, this.sim.tickHistoryDepth);
        const recentTicks: ExplorerData["recentTicks"] = [];
        for (let t = Math.max(initialTick, tick - reach + 1); t <= tick; t++) {
            const txCount = this.sim.tickTransactions(t).length;
            const leader = committee.computors[t % committee.size];
            recentTicks.push({
                tick: t,
                leader: leader ? await bytesToIdentity(leader.publicKey) : "",
                empty: txCount === 0,
                txCount,
                timestamp: this.tickTimestamp(t),
            });
        }

        return {
            header: {
                tick,
                epoch,
                initialTick,
                alignedVotes: this.sim.alignedVotes(tick),
                ticksInCurrentEpoch: Math.max(0, tick - initialTick),
                latestCreatedTick: tick,
                mainAuxStatus: 1,
                isSavingSnapshot: false,
            },
            recentTicks,
            mempool: {
                totalPending: pending.reduce((sum, entry) => sum + entry.count, 0),
                perTick: pending,
            },
            // The simulator is a single in-process node with no peer book.
            network: { connectedPeers: 0, outgoing: 0, incoming: 0 },
            spectrum: {
                circulatingSupply: spectrum.totalAmount.toString(),
                activeAddresses: spectrum.numberOfEntities,
            },
        };
    }

    async tickData(tick: number): Promise<ExplorerTickData | null> {
        const td = this.sim.tickData(tick);
        if (!td) {
            return null;
        }

        return {
            tickNumber: tick,
            epoch: td.epoch,
            computorIndex: td.computorIndex,
            timestamp: this.tickTimestamp(tick),
            timelock: Buffer.from(td.timelock.bytes).toString("base64"),
            transactionDigests: this.sim.tickTransactions(tick).map((record) => record.txId),
            signature: Buffer.from(td.signature).toString("base64"),
        };
    }

    async tickTransactions(tick: number): Promise<ExplorerTx[]> {
        const records = this.sim.tickTransactions(tick);
        return Promise.all(records.map((record) => this.tx(record)));
    }

    async txByHash(hash: string): Promise<ExplorerTx | null> {
        const record = this.sim.txByHash(hash.toLowerCase());
        return record ? this.tx(record) : null;
    }

    // Scans the retained tick window newest-first. Older history is pruned by the chain, so this is a recent
    // view rather than the entity's whole life.
    async transfersForIdentity(
        identity: string,
        direction: "in" | "out" | "both",
        limit: number,
    ): Promise<{ identity: string; count: number; transactions: IdentityTransfer[] }> {
        const target = toHex(this.node.idToBytes(identity));
        const transactions: IdentityTransfer[] = [];
        const capped = Math.max(1, Math.min(limit, 1000));

        for (let tick = this.sim.currentTick; tick >= 0 && transactions.length < capped; tick--) {
            for (const record of this.sim.tickTransactions(tick)) {
                const isOut = record.source === target;
                const isIn = record.dest === target;
                if (!isOut && !isIn) continue;
                if (direction === "in" && !isIn) continue;
                if (direction === "out" && !isOut) continue;

                transactions.push({
                    ...(await this.tx(record)),
                    direction: isOut ? "out" : "in",
                });
                if (transactions.length >= capped) break;
            }
        }

        return { identity, count: transactions.length, transactions };
    }

    async contractCalls(options: { fromTick: number; toTick: number; contractIndex?: number; page?: number; pageSize?: number }): Promise<ContractCallsPage> {
        // Same clamps core applies: at most a 1000-tick scan and 200 rows per page.
        const toTick = Math.min(options.toTick, this.sim.currentTick);
        const fromTick = Math.max(0, Math.max(options.fromTick, toTick - 999));
        const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 200));
        const page = Math.max(0, options.page ?? 0);

        const hits: { record: TxRecord; contractIndex: number }[] = [];
        for (let tick = toTick; tick >= fromTick; tick--) {
            for (const record of this.sim.tickTransactions(tick)) {
                const slot = this.sim.contractSlotOf(hexToBytes(record.dest));
                if (slot < 1) continue;
                if (options.contractIndex != null && slot !== options.contractIndex) continue;
                hits.push({ record, contractIndex: slot });
            }
        }

        const pageHits = hits.slice(page * pageSize, page * pageSize + pageSize);
        const transactions = await Promise.all(
            pageHits.map(async (hit) => ({
                ...(await this.tx(hit.record)),
                contractIndex: hit.contractIndex,
            })),
        );

        return { fromTick, toTick, total: hits.length, page, pageSize, transactions };
    }

    async contracts(): Promise<{ contracts: ContractListEntry[]; count: number }> {
        const registry = await this.node.dynRegistry();
        // The registry reports every dynamic slot, including the empty ones; a catalog only lists real deployments.
        const contracts = registry.contracts
            .filter((entry) => entry.armed)
            .map((entry) => ({
                index: entry.index,
                name: entry.name,
                // The simulator deploys outside the epoch lifecycle, so it has no construction/destruction epochs.
                constructionEpoch: 0,
                destructionEpoch: 0,
                stateSize: this.sim.contracts.get(entry.index)?.state().length ?? 0,
            }));

        return { contracts, count: contracts.length };
    }
}
