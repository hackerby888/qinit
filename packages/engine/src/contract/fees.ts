// Execution-fee reserves mirror core-lite Contract-0 accounting and Qinit's simulation policy.
import { MAX_NUMBER_OF_CONTRACTS } from "../chain/consensus";
import { MAINNET_COMPUTOR_COUNT } from "@qinit/proto";

// "off" preserves legacy execution; "metered" enforces live fee reserves.
export type FeeMode = "off" | "metered";

const IPO_COMPUTORS = BigInt(MAINNET_COMPUTOR_COUNT);
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

    getContractFeeReserve(slot: number): bigint {
        return this.reserve.get(slot) ?? 0n;
    }

    // Set a contract's reserve directly (tests / IDE faucet). A positive value clears any prior IPO-failed mark.
    setContractFeeReserve(slot: number, amount: bigint): void {
        this.reserve.set(slot, amount);
        if (amount > 0n) {
            this.failed.delete(slot);
        }
    }

    // Model the IPO outcome: a 0 finalPrice is a failed IPO that burns can never refill.
    ipo(slot: number, finalPrice: bigint): void {
        if (finalPrice > 0n) {
            this.reserve.set(slot, finalPrice * IPO_COMPUTORS);
            this.failed.delete(slot);
        } else {
            this.reserve.set(slot, 0n);
            this.failed.add(slot);
        }
    }

    // Spec gate before fee-bearing entries: metered contracts need a positive reserve (always true when fees are off).
    reserveOk(slot: number): boolean {
        return this.mode === "off" || this.getContractFeeReserve(slot) > 0n;
    }

    addToContractFeeReserve(slot: number, amount: bigint): void {
        if (amount <= 0n) {
            return;
        }
        this.reserve.set(slot, this.getContractFeeReserve(slot) + amount);
    }

    // The reserve is a sint64 and may go non-positive, leaving the contract dormant until refilled (per the spec).
    subtractFromContractFeeReserve(slot: number, cost: bigint): void {
        if (cost <= 0n) {
            return;
        }
        this.reserve.set(slot, this.getContractFeeReserve(slot) - cost);
    }

    // True for a contract whose IPO failed (finalPrice 0) — a burn must not refill it.
    isFailed(slot: number): boolean {
        return this.failed.has(slot);
    }

    // Metered deploys seed the default reserve (a faked successful IPO) unless already funded; INITIALIZE is exempt from the gate.
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
        return this.getContractFeeReserve(idx);
    }
}
