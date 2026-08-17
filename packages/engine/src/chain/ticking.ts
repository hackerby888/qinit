// Tick consensus state and history, mirroring core-lite vote processing.
// The leader signs each tick's transaction digests in TickData.
import { Committee, type CommitteeOpts, type TickStateDigests, buildTickVote, buildTickData, voteIsAligned, DEFAULT_NUMBER_OF_COMPUTORS } from "./consensus";
import { k12Bytes } from "../support/k12";
import type { Tick, TickData } from "../protocol/wire";

export const DEFAULT_TICK_HISTORY = Infinity; // unlimited: retain all finalized ticks; pass a finite number to cap
const ZERO32 = new Uint8Array(32);

// A finalized tick's consensus record, stored per tick for quorum-tick / current-tick-info queries.
export interface TickRecord {
    // Signed votes expose fields directly; bytes remains the canonical buffer.
    votes: Tick[];
    aligned: number;
    total: number;
    digests: TickStateDigests;
    tickData: TickData; // the leader's signed TickData; the votes commit transaction = K12(tickData.bytes)
}

// The seams TickConsensus needs from the rest of the engine.
export interface ConsensusHost {
    getSpectrumDigest(): Uint8Array;
    getUniverseDigest(): Uint8Array;
    getComputerDigest(): Uint8Array;
    tickTransactionDigests(tick: number): Uint8Array[];
    nowMs(): number;
    tick(): number;
    epoch(): number;
}

export class TickConsensus {
    private readonly host: ConsensusHost;
    private readonly opts: CommitteeOpts;
    private readonly lite: boolean; // skip the per-tick quorum (votes/TickData) for EMPTY ticks — see finalizeTick
    private readonly historyTicks: number;
    private committee: Committee | null = null; // derived lazily on first finalize (needs initK12 resolved)
    private ticks = new Map<number, TickRecord>(); // per-tick quorum record
    private lastDigests: { spectrum: Uint8Array; universe: Uint8Array; computer: Uint8Array } = {
        spectrum: ZERO32,
        universe: ZERO32,
        computer: ZERO32,
    }; // previous tick's committed roots

    constructor(host: ConsensusHost, opts: CommitteeOpts, lite = false, historyTicks = DEFAULT_TICK_HISTORY) {
        this.host = host;
        this.opts = opts;
        this.lite = lite;
        this.historyTicks = Math.max(1, Math.trunc(historyTicks));
    }

    // The configured committee size, available without deriving keys (used for dividend payout + quorum sizing).
    committeeSize(): number {
        return this.opts.computorSeeds?.length ?? this.opts.numberOfComputors ?? DEFAULT_NUMBER_OF_COMPUTORS;
    }

    // The committee, derived (sync FourQ) on first use — requires initK12() to have resolved the crypto module.
    getCommittee(): Committee {
        if (!this.committee) {
            this.committee = new Committee(this.opts);
        }

        return this.committee;
    }

    quorum(): number {
        return this.getCommittee().quorum;
    }

    // The previous tick's committed roots, read by this tick's contracts as qpi prev*Digest.
    getPrevSpectrumDigest(): Uint8Array {
        return this.lastDigests.spectrum;
    }

    getPrevUniverseDigest(): Uint8Array {
        return this.lastDigests.universe;
    }

    getPrevComputerDigest(): Uint8Array {
        return this.lastDigests.computer;
    }

    // The leader (computor[tick % N]) packs the tick's per-tx digests into a signed TickData; each computor
    // signs a Tick vote with K12(TickData).
    finalizeTick(): void {
        const tick = this.host.tick();
        const epoch = this.host.epoch();
        const spectrum = this.host.getSpectrumDigest();
        const universe = this.host.getUniverseDigest();
        const computer = this.host.getComputerDigest();
        this.lastDigests = { spectrum, universe, computer }; // the next tick's contracts read these as prev*Digest

        const txDigests = this.host.tickTransactionDigests(tick);

        // Empty lite-mode ticks commit no transactions, so skip their expensive quorum records.
        if (this.lite && txDigests.length === 0) {
            this.pruneTicks(tick);
            return;
        }

        const committee = this.getCommittee();
        const tickData = buildTickData(committee, epoch, tick, txDigests, { spectrum, universe, computer }, this.host.nowMs());

        const digests: TickStateDigests = {
            spectrum,
            universe,
            computer,
            transaction: k12Bytes(tickData.bytes),
            expectedNextTransaction: new Uint8Array(32),
        };

        const votes: Tick[] = [];
        let aligned = 0;
        for (const c of committee.computors) {
            const vote = buildTickVote(c, epoch, tick, digests, this.host.nowMs());
            votes.push(vote);
            if (voteIsAligned(vote, digests)) {
                aligned++;
            }
        }

        if (aligned < committee.quorum) {
            throw new Error(`tick ${tick}: aligned votes ${aligned} < quorum ${committee.quorum}`);
        }

        this.ticks.set(tick, { votes, aligned, total: votes.length, digests, tickData });
        this.pruneTicks(tick);
    }

    private pruneTicks(tick: number): void {
        const firstRetainedTick = tick - this.historyTicks + 1;
        for (const t of this.ticks.keys()) {
            if (t < firstRetainedTick) {
                this.ticks.delete(t);
            }
        }
    }

    tickRecord(tick: number): TickRecord | undefined {
        return this.ticks.get(tick);
    }

    // The stored signed TickData for a finalized tick; undefined if never finalized or already pruned.
    tickData(tick: number): TickData | undefined {
        return this.ticks.get(tick)?.tickData;
    }

    // Aligned votes for a tick (0 if not yet finalized) — CurrentTickInfo.numberOfAlignedVotes.
    alignedVotes(tick: number): number {
        return this.ticks.get(tick)?.aligned ?? 0;
    }

    // The arbitrator-signed Computors wire list for the current epoch. slotCount pads for the peer-protocol bridge.
    signedComputorList(slotCount?: number): Uint8Array {
        return this.getCommittee().signedComputorList(this.host.epoch(), slotCount);
    }
}
