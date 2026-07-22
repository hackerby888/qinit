// Execution-fee reserves mirror core-lite Contract-0 accounting and Qinit's simulation policy.
import { MAX_NUMBER_OF_CONTRACTS } from "./consensus";

// "off" preserves legacy execution; "metered" enforces live fee reserves.
export type FeeMode = "off" | "metered";

const IPO_COMPUTORS = 676n; // NUMBER_OF_COMPUTORS — a completed IPO funds the reserve to finalPrice * 676
export const DEFAULT_FEE_RESERVE = 1000000000n; // seed a metered deploy gets (a faked successful IPO)
const OFF_MODE_RESERVE = 1000000n; // queryFeeReserve's constant return when fees are off

export class FeeManager {
  readonly mode: FeeMode;
  private readonly defaultReserve: bigint;
  private readonly reserve = new Map<number, bigint>(); // per-contract executionFeeReserve
  private readonly failed = new Set<number>(); // contracts whose IPO failed (finalPrice 0) — can't be refilled

  constructor(mode: FeeMode = "off", defaultReserve: bigint = DEFAULT_FEE_RESERVE) {
    this.mode = mode;
    this.defaultReserve = defaultReserve;
  }

  get metered(): boolean {
    return this.mode === "metered";
  }

  // getContractFeeReserve — the current reserve of a contract; 0 if never funded.
  getReserve(slot: number): bigint {
    return this.reserve.get(slot) ?? 0n;
  }

  // Set a contract's reserve directly (tests / IDE faucet). A positive value clears any prior IPO-failed mark.
  setReserve(slot: number, amount: bigint): void {
    this.reserve.set(slot, amount);
    if (amount > 0n) {
      this.failed.delete(slot);
    }
  }

  // Model the IPO outcome that seeds the reserve: finalPrice > 0 funds it to finalPrice * 676; finalPrice 0 is a
  // failed IPO — the contract is marked failed, its reserve stays 0, and burning can no longer refill it.
  ipo(slot: number, finalPrice: bigint): void {
    if (finalPrice > 0n) {
      this.reserve.set(slot, finalPrice * IPO_COMPUTORS);
      this.failed.delete(slot);
    } else {
      this.reserve.set(slot, 0n);
      this.failed.add(slot);
    }
  }

  // The gate the spec checks before fee-bearing entry points: a metered contract must hold a positive reserve.
  // Always true when fees are off.
  reserveOk(slot: number): boolean {
    return this.mode === "off" || this.getReserve(slot) > 0n;
  }

  // addToContractFeeReserve — credit fees (e.g. a burn that funds a contract's reserve).
  add(slot: number, amount: bigint): void {
    if (amount <= 0n) {
      return;
    }
    this.reserve.set(slot, this.getReserve(slot) + amount);
  }

  // subtractFromContractFeeReserve — debit a completed call's metered cost. The reserve is a sint64 and may go
  // non-positive; that leaves the contract dormant until refilled (the next reserveOk check fails), per the spec.
  sub(slot: number, cost: bigint): void {
    if (cost <= 0n) {
      return;
    }
    this.reserve.set(slot, this.getReserve(slot) - cost);
  }

  // True for a contract whose IPO failed (finalPrice 0) — a burn must not refill it.
  isFailed(slot: number): boolean {
    return this.failed.has(slot);
  }

  // A metered deploy is seeded with the default reserve (a faked successful IPO) unless it was already funded
  // (tests override beforehand with setReserve/ipo). Construction (INITIALIZE) is exempt from the reserve gate.
  seedOnDeploy(slot: number): void {
    if (this.metered && !this.reserve.has(slot)) {
      this.reserve.set(slot, this.defaultReserve);
    }
  }

  // qpi.queryFeeReserve(contractIndex): off => the legacy positive constant; metered => the live reserve, with
  // an out-of-range index resolving to the caller's own contract (qpi_spectrum_impl.h queryFeeReserve).
  queryFeeReserve(callerSlot: number, ci: number): bigint {
    if (this.mode === "off") {
      return OFF_MODE_RESERVE;
    }
    const idx = ci < 1 || ci >= MAX_NUMBER_OF_CONTRACTS ? callerSlot : ci;
    return this.getReserve(idx);
  }
}
