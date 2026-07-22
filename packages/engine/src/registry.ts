// Registry for deployed Wasm contracts, persistent state, metered calls, and the computer digest.
import { Contract, type HostServices, KIND, SP } from "./runtime";
import { k12Bytes } from "./k12";

// The wasm K12 mallocs its whole input; ~8 MB is the safe ceiling before it overflows. Contract states above
// this (the mainnet-sized order books of QX/QSWAP) get a zero computer-digest leaf instead — see computerDigest.
export const K12_MAX_LEAF_BYTES = 8 * 1024 * 1024;
import { merkleRoot, MAX_NUMBER_OF_CONTRACTS } from "./consensus";
import { TraceRecorder } from "./trace";
import { FeeManager } from "./fees";

// The invocation context threaded into a contract entry (the qpi caller/reward + the entry point being run).
export interface FireContext {
  invocator?: Uint8Array;
  originator?: Uint8Array;
  invocationReward?: bigint;
  entryPoint?: number;
}

export class ContractRegistry {
  readonly contracts = new Map<number, Contract>(); // slot -> wasm contract instance + state
  readonly dirty = new Set<number>(); // slots whose state changed this tick (qpi markDirty)
  private readonly fees: FeeManager;
  private readonly recorder: TraceRecorder;

  constructor(fees: FeeManager, recorder: TraceRecorder) {
    this.fees = fees;
    this.recorder = recorder;
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

  // Load or redeploy Wasm, then initialize or migrate state.
  // Metered deployments are pre-funded; INITIALIZE is exempt.
  deploy(
    slot: number,
    wasm: Uint8Array,
    host: HostServices,
    extMem?: WebAssembly.Memory,
    extraImports?: WebAssembly.Imports,
  ): Contract {
    const prev = this.contracts.get(slot); // existing instance => this is a redeploy
    const prevState = prev ? prev.state() : null; // snapshot old state before the new instance replaces it
    const c = Contract.load(wasm, slot, host, extMem, extraImports);
    c.trace = this.recorder;
    c.metering = this.fees.metered;
    this.contracts.set(slot, c);
    this.fees.seedOnDeploy(slot);

    if (!prevState) {
      // first deploy: zero state + run INITIALIZE
      c.zeroState();
      if (c.hasSysproc(SP.INITIALIZE)) {
        this.fire(c, KIND.SYSPROC, SP.INITIALIZE, new Uint8Array(0), { entryPoint: SP.INITIALIZE });
      }
      c.everInitialized = true;
    } else if (c.hasMigrate && c.migrateOldStateSize === prevState.length) {
      c.migrate(prevState); // upgrade: __migrate transforms old -> new layout (parity w/ core)
      c.everInitialized = true;
    } else {
      // upgrade without migrate: preserve the overlap, never re-INITIALIZE
      c.zeroState();
      c.writeState(prevState);
      c.everInitialized = true;
    }
    return c;
  }

  // Remove a deployed contract (dev convenience — `qinit system rm`). Single-authority engine, so no consensus
  // implication; the slot simply goes empty.
  undeploy(slot: number): boolean {
    return this.contracts.delete(slot);
  }

  // Run a mutating entry and debit its measured cost when metering is enabled.
  // Read-only queries bypass this path.
  fire(c: Contract, kind: number, it: number, input: Uint8Array, ctx: FireContext): Uint8Array {
    const out = c.invoke(kind, it, input, ctx);
    if (this.fees.metered) {
      this.fees.sub(c.slot, c.lastCost);
    }
    return out;
  }

  // The K12 digest of a single contract's state (the IDE/test inspection hook).
  digest(slot: number): string {
    return this.contracts.get(slot)!.digest();
  }

  // computerDigest — the faithful K12 merkle over MAX_NUMBER_OF_CONTRACTS contract-state leaves (leaf =
  // K12(StateData); an empty slot is zero). The one system digest the sim reproduces exactly vs core-lite.
  computerDigest(): Uint8Array {
    const leaves = new Map<number, Uint8Array>();
    for (const [slot, c] of this.contracts) {
      // States above the one-shot Wasm K12 limit use a zero digest leaf.
      leaves.set(slot, c.stateSize > K12_MAX_LEAF_BYTES ? new Uint8Array(32) : k12Bytes(c.state()));
    }

    return merkleRoot(leaves, MAX_NUMBER_OF_CONTRACTS);
  }
}
