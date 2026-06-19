// Layer 2 (minimal) — chain-sim. The simplified "node" that drives contracts: deploy/registry, tick/epoch
// counters, and the lifecycle-sweep skeleton. MVP scope = enough to run the qinit Counter flow
// (deploy -> Get -> Inc -> Get) and produce the state digest. The asc/desc sweep direction is wired from day
// one so the "Execution scheduling parity contract" (see plan) is structurally correct as it grows.
import { Contract, HostServices, KIND, SP } from "./runtime";

export class Sim {
  tickN = 0;
  epochN = 0;
  contracts = new Map<number, Contract>();
  dirty = new Set<number>();
  host: HostServices;

  constructor() {
    this.host = {
      tick: () => this.tickN,
      epoch: () => this.epochN,
      markDirty: (slot) => this.dirty.add(slot),
      log: () => {},
    };
  }

  private slots(asc: boolean): number[] {
    return [...this.contracts.keys()].sort((a, b) => (asc ? a - b : b - a));
  }

  // Deploy + construct: the node zeroes state then runs INITIALIZE (qubic.cpp contractProcessor INITIALIZE).
  deploy(slot: number, wasm: Uint8Array): Contract {
    const c = Contract.load(wasm, slot, this.host);
    this.contracts.set(slot, c);
    c.zeroState();
    if (c.hasSysproc(SP.INITIALIZE)) c.invoke(KIND.SYSPROC, SP.INITIALIZE);
    return c;
  }

  beginTick(): void {
    this.tickN++;
    for (const s of this.slots(true)) {                 // BEGIN_TICK: ascending 1->N
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.BEGIN_TICK)) c.invoke(KIND.SYSPROC, SP.BEGIN_TICK);
    }
  }

  endTick(): void {
    for (const s of this.slots(false)) {                // END_TICK: descending N->1
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.END_TICK)) c.invoke(KIND.SYSPROC, SP.END_TICK);
    }
  }

  query(slot: number, it: number, input?: Uint8Array): Uint8Array {
    return this.contracts.get(slot)!.invoke(KIND.FUNCTION, it, input);
  }

  // MVP: amount 0 -> no POST_INCOMING_TRANSFER; a single user-procedure call.
  procedure(slot: number, it: number, input?: Uint8Array): Uint8Array {
    return this.contracts.get(slot)!.invoke(KIND.PROCEDURE, it, input);
  }

  digest(slot: number): string {
    return this.contracts.get(slot)!.digest();
  }
}
