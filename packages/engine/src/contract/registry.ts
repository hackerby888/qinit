// Registry for deployed Wasm contracts, persistent state, metered calls, and the computer digest.
import { SYSTEM_PROCEDURES } from "@qinit/core";
import { Contract, type HostServices, CONTRACT_ENTRY_KIND } from "./runtime";
import { k12Bytes } from "../support/k12";

// The wasm K12 mallocs its whole input, so ~8 MB is the safe ceiling; contract states above this get a zero computer-digest leaf instead.
export const K12_MAX_LEAF_BYTES = 8 * 1024 * 1024;
import { merkleRoot, MAX_NUMBER_OF_CONTRACTS } from "../chain/consensus";
import { TraceRecorder } from "../logging/trace";
import { FeeManager } from "./fees";
import type { Id } from "../support/bytes";

// The invocation context threaded into a contract entry (the qpi caller/reward + the entry point being run).
export interface FireContext {
    invocator?: Id;
    originator?: Id;
    invocationReward?: bigint;
    entryPoint?: number;
}

export class ContractRegistry {
    readonly contracts = new Map<number, Contract>();
    readonly dirty = new Set<number>(); // slots whose state changed this tick (qpi markDirty)
    // Never cleared; a reader compares it across the reads of one view.
    // Outside the state bytes, so digests are unaffected.
    private readonly versions = new Map<number, number>();
    // told of every execution fee taken from a reserve, so a node with a log stream can record it.
    onReserveDeduction?: (slot: number, deducted: bigint, remaining: bigint) => void;
    // slots armed by a deferred deploy, with the old state a pending MIGRATE reads.
    private readonly pendingConstruction = new Map<number, { oldState: Uint8Array | null; initialize: boolean }>();
    private readonly fees: FeeManager;
    private readonly recorder: TraceRecorder;

    constructor(fees: FeeManager, recorder: TraceRecorder) {
        this.fees = fees;
        this.recorder = recorder;
    }

    bumpStateVersion(slot: number): void {
        this.versions.set(slot, (this.versions.get(slot) ?? 0) + 1);
    }

    stateVersion(slot: number): number {
        return this.versions.get(slot) ?? 0;
    }

    get(slot: number): Contract | undefined {
        return this.contracts.get(slot);
    }

    has(slot: number): boolean {
        return this.contracts.has(slot);
    }

    // The deployed slots in ascending (BEGIN_*) or descending (END_*) order.
    slots(asc: boolean): number[] {
        return [...this.contracts.keys()].sort((a, b) => (asc ? a - b : b - a));
    }

    // Metered deployments are pre-funded; INITIALIZE is exempt.
    deploy(
        slot: number,
        wasm: Uint8Array,
        host: HostServices,
        extMem?: WebAssembly.Memory,
        extraImports?: WebAssembly.Imports,
        initialize = true,
        initialState?: Uint8Array,
        minIoBytes?: number,
        deferConstruction = false,
    ): Contract {
        const prev = this.contracts.get(slot);
        const stillPending = this.pendingConstruction.get(slot);
        // snapshot old state before the new instance replaces it; a seeded state stands in for it, and a resident still waiting to migrate
        // hands on the old state it was waiting with.
        const residentState = stillPending?.oldState ?? (prev ? prev.state() : null);
        const prevState = initialState ?? residentState;
        // core keeps a redeployed slot's bytes and still owes it the INITIALIZE its first deploy never reached.
        const owedInitialize = !initialState && stillPending !== undefined && stillPending.oldState === null;
        const c = Contract.load(wasm, slot, host, extMem, extraImports);

        // core refuses a module whose io region cannot hold its engine carve; a node that mirrors core names the same minimum, in core's words.
        if (minIoBytes !== undefined && c.ioBytes < minIoBytes) {
            throw new Error("contract io region too small for the engine carve (rebuild the contract)");
        }

        // a seeded state must fit the new layout or its MIGRATE input; checked before the resident contract is replaced
        if (initialState) {
            const migrates = c.hasMigrate && c.migrateOldStateSize === initialState.length;
            if (!migrates && initialState.length !== c.stateSize) {
                const accepted = c.hasMigrate ? `${c.stateSize} B (or ${c.migrateOldStateSize} B for MIGRATE)` : `${c.stateSize} B`;
                throw new Error(`initial state is ${initialState.length} B, slot ${slot} expects ${accepted}`);
            }
        }
        c.trace = this.recorder;
        c.metering = this.fees.metered;
        this.pendingConstruction.delete(slot);
        this.contracts.set(slot, c);
        this.fees.seedOnDeploy(slot);

        const migrates = prevState !== null && c.hasMigrate && c.migrateOldStateSize === prevState.length;
        if (deferConstruction && (!prevState || migrates)) {
            // core arms a slot in the deploy's tick and runs INITIALIZE or MIGRATE at the head of the next one; until then the state is blank.
            c.zeroState();
            this.pendingConstruction.set(slot, { oldState: migrates ? prevState : null, initialize });
            return c;
        }

        if (!prevState) {
            // first deploy: zero state + run INITIALIZE, unless a gtest fixture runs it itself as native INIT_CONTRACT expects
            c.zeroState();
            this.construct(c, null, initialize);
        } else if (migrates) {
            this.construct(c, prevState, initialize);
        } else {
            // upgrade without migrate: preserve the overlap, never re-INITIALIZE
            c.zeroState();
            c.writeState(prevState);
            if (!owedInitialize) {
                c.everInitialized = true;
            } else if (deferConstruction) {
                this.pendingConstruction.set(slot, { oldState: null, initialize });
            } else {
                this.construct(c, null, initialize);
            }
        }
        return c;
    }

    private construct(c: Contract, oldState: Uint8Array | null, initialize: boolean): void {
        if (oldState) {
            c.migrate(oldState); // upgrade: __migrate transforms old -> new layout (parity w/ core)
        } else if (initialize && c.hasSysproc(SYSTEM_PROCEDURES.INITIALIZE)) {
            this.fire(c, CONTRACT_ENTRY_KIND.SYSPROC, SYSTEM_PROCEDURES.INITIALIZE, new Uint8Array(0), {
                entryPoint: SYSTEM_PROCEDURES.INITIALIZE,
            });
        }
        c.everInitialized = true;
    }

    pendingConstructionSlots(): number[] {
        return [...this.pendingConstruction.keys()];
    }

    /** runs the INITIALIZE or MIGRATE a deferred deploy left for the next tick. */
    constructPending(slot: number): void {
        const pending = this.pendingConstruction.get(slot);
        const contract = this.contracts.get(slot);
        this.pendingConstruction.delete(slot);
        if (pending && contract) {
            this.construct(contract, pending.oldState, pending.initialize);
        }
    }

    // Remove a deployed contract (`qinit system rm`). Single-authority engine, so no consensus implication — the slot simply goes empty.
    undeploy(slot: number): boolean {
        this.pendingConstruction.delete(slot);
        return this.contracts.delete(slot);
    }

    // Run a mutating entry and charge its measured cost against the fee reserve when metering is on; read-only queries bypass this path.
    fire(c: Contract, kind: number, it: number, input: Uint8Array, ctx: FireContext): Uint8Array {
        const out = c.invoke(kind, it, input, ctx);
        if (this.fees.metered && c.lastCost > 0n) {
            this.fees.subtractFromContractFeeReserve(c.slot, c.lastCost);
            this.onReserveDeduction?.(c.slot, c.lastCost, this.fees.getContractFeeReserve(c.slot));
        }
        return out;
    }

    // The K12 digest of a single contract's state (the IDE/test inspection hook).
    digest(slot: number): string {
        return this.contracts.get(slot)!.digest();
    }

    // The faithful K12 merkle over MAX_NUMBER_OF_CONTRACTS state leaves (leaf = K12(StateData), empty slot zero) — the one digest reproduced exactly.
    getComputerDigest(): Uint8Array {
        const leaves = new Map<number, Uint8Array>();
        for (const [slot, c] of this.contracts) {
            leaves.set(slot, c.stateSize > K12_MAX_LEAF_BYTES ? new Uint8Array(32) : k12Bytes(c.state()));
        }

        return merkleRoot(leaves, MAX_NUMBER_OF_CONTRACTS);
    }
}
