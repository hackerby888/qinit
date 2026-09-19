// Execution-fee reserves mirror core-lite Contract-0 accounting and Qinit's simulation policy.
import { MAINNET_COMPUTOR_COUNT } from "@qinit/proto";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core";

// "off" preserves legacy execution; "metered" enforces live fee reserves.
export type FeeMode = "off" | "metered";

const IPO_COMPUTORS = BigInt(MAINNET_COMPUTOR_COUNT);
// The dev reserve a metered deploy is seeded with (a faked successful IPO); the node seeds the same, about a hundred procedures on a near-1 GiB state.
export const DEFAULT_FEE_RESERVE = 100000000000n;
const OFF_MODE_RESERVE = 1000000n; // queryFeeReserve's constant return when fees are off
const MAX_RESERVE = (1n << 63n) - 1n; // the reserve is a sint64, and a credit saturates there
// core's contractCount: every system contract plus the dynamic slots that follow them.
export const DEFAULT_CONTRACT_COUNT = DEFAULT_WASM_SLOT_LAYOUT.slotBase + DEFAULT_WASM_SLOT_LAYOUT.slotCount;

export class FeeManager {
    readonly mode: FeeMode;
    private readonly defaultReserve: bigint;
    private readonly reserve = new Map<number, bigint>(); // per-contract executionFeeReserve
    private readonly failed = new Set<number>(); // contracts whose IPO failed (finalPrice 0) — can't be refilled

    private readonly contractCount: number;

    constructor(mode: FeeMode = "off", defaultReserve: bigint = DEFAULT_FEE_RESERVE, contractCount: number = DEFAULT_CONTRACT_COUNT) {
        this.mode = mode;
        this.defaultReserve = defaultReserve;
        this.contractCount = contractCount;
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

    // The credit lands on the value queryFeeReserve reports, so a contract reading before and after sees exactly the amount.
    addToContractFeeReserve(slot: number, amount: bigint): void {
        if (amount <= 0n) {
            return;
        }
        const credited = this.reportedReserve(slot) + amount;
        this.reserve.set(slot, credited > MAX_RESERVE ? MAX_RESERVE : credited);
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

    // An index outside core's [1, contractCount) names the calling contract itself.
    resolveIndex(callerSlot: number, contractIndex: number): number {
        return contractIndex < 1 || contractIndex >= this.contractCount ? callerSlot : contractIndex;
    }

    // qpi.queryFeeReserve(contractIndex): the live reserve. off mode answers a reserve nobody set with the legacy constant, and one a test
    // set with that value, as core's harness does.
    queryFeeReserve(callerSlot: number, ci: number): bigint {
        return this.reportedReserve(this.resolveIndex(callerSlot, ci));
    }

    private reportedReserve(slot: number): bigint {
        if (this.mode === "off") {
            return this.reserve.get(slot) ?? OFF_MODE_RESERVE;
        }
        return this.getContractFeeReserve(slot);
    }
}
