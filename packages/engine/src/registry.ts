// The contract registry — the deployed contracts (their wasm instances + persistent state), the deploy/construct
// path, the metered invoke (fire), and the computer digest (the K12 merkle over contract-state leaves). The TS
// analogue of core-lite contract_core (contractStates + the contract processor) + getComputerDigest. It owns the
// contract instances and runs them; the orchestrator (Sim) decides what to run and sequences the tick. The fee
// metering is delegated to the injected FeeManager.
import { Contract, type HostServices, KIND, SP } from "./runtime";
import { k12Bytes } from "./k12";
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

  // Deploy + construct: load the wasm, zero state, then run INITIALIZE (qubic.cpp contractProcessor INITIALIZE).
  // A metered contract is born funded (a successful IPO) unless its reserve was pre-set; INITIALIZE is exempt
  // from the reserve gate.
  deploy(slot: number, wasm: Uint8Array, host: HostServices): Contract {
    const c = Contract.load(wasm, slot, host);
    c.trace = this.recorder;
    c.metering = this.fees.metered;
    this.contracts.set(slot, c);
    c.zeroState();

    this.fees.seedOnDeploy(slot);

    if (c.hasSysproc(SP.INITIALIZE)) {
      this.fire(c, KIND.SYSPROC, SP.INITIALIZE, new Uint8Array(0), { entryPoint: SP.INITIALIZE });
    }
    return c;
  }

  // Remove a deployed contract (dev convenience — `qinit system rm`). Single-authority engine, so no consensus
  // implication; the slot simply goes empty.
  undeploy(slot: number): boolean {
    return this.contracts.delete(slot);
  }

  // Run a contract entry and, when metered, debit its measured cost from its own reserve. Every Sim-driven
  // procedure / sysproc / callback goes through here; read-only function queries deliberately do not (they are
  // never charged). Re-entrant frames each report their own lastCost, so nested calls are charged correctly.
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
      leaves.set(slot, k12Bytes(c.state()));
    }

    return merkleRoot(leaves, MAX_NUMBER_OF_CONTRACTS);
  }
}
