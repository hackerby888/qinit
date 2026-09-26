// Execution-fee reserves mirror core-lite Contract-0 accounting and Qinit's simulation policy.
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core";
import { DEFAULT_NUMBER_OF_COMPUTORS } from "../chain/consensus";

// "off" preserves legacy execution; "metered" enforces live fee reserves.
export type FeeMode = "off" | "metered";

// One contract's charge at a phase boundary; the fields are core's ContractReserveDeduction record.
export interface FeeSettlement {
    contractIndex: number;
    deductedAmount: bigint;
    remainingAmount: bigint;
}

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

    // core's ExecutionTimeAccumulator: microseconds per contract over a phase of NUMBER_OF_COMPUTORS ticks, charged once at the
    // boundary. Core needs two arrays because the previous phase's report travels as a transaction; a single authority reports to
    // itself, so one accumulation and no calculateAscendingQuorumValue over the computor slots.
    private readonly contractExecutionTimePerPhase = new Map<number, bigint>();
    private settledPhaseNumber = -1;
    // core's phase is exactly its computor count; set from the live committee.
    numberOfComputors = DEFAULT_NUMBER_OF_COMPUTORS;
    // core's price knob: executionFee = executionTime * multiplierNumerator / multiplierDenominator (execution_fees.h, default 1/1).
    multiplierNumerator = 1n;
    multiplierDenominator = 1n;

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
            this.reserve.set(slot, finalPrice * BigInt(this.numberOfComputors));
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

    // the credit lands on the value queryFeeReserve reports, so a contract reading before and after sees exactly the amount.
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

    // core's ExecutionTimeAccumulator::addTime: the measured cost joins this phase's total and touches no reserve.
    addTime(slot: number, time: bigint): void {
        if (!this.metered || time <= 0n) {
            return;
        }
        this.contractExecutionTimePerPhase.set(slot, (this.contractExecutionTimePerPhase.get(slot) ?? 0n) + time);
    }

    // What this phase would report for a contract, before the boundary charges it.
    executionFee(slot: number): bigint {
        return this.priceOf(this.contractExecutionTimePerPhase.get(slot) ?? 0n);
    }

    // core's phase index: the report carries it as phaseNumber (execution_fees.h).
    phaseNumber(tick: number): number {
        return Math.floor(tick / this.numberOfComputors);
    }

    // Charge the finished phase the first time a tick of the next one is entered; core does it at a fixed offset
    // into the phase because the reports travel as transactions.
    processReportsOnNewPhase(tick: number): FeeSettlement[] {
        const phase = this.phaseNumber(tick);
        if (phase === this.settledPhaseNumber) {
            return [];
        }
        this.settledPhaseNumber = phase;
        return this.processReports();
    }

    // core's ExecutionFeeReportCollector::processReports, minus the quorum: one deduction and one log record per contract that ran.
    processReports(): FeeSettlement[] {
        const settlements: FeeSettlement[] = [];
        for (const slot of [...this.contractExecutionTimePerPhase.keys()].sort((a, b) => a - b)) {
            const deductedAmount = this.priceOf(this.contractExecutionTimePerPhase.get(slot)!);
            if (deductedAmount <= 0n) {
                continue;
            }
            this.subtractFromContractFeeReserve(slot, deductedAmount);
            settlements.push({ contractIndex: slot, deductedAmount, remainingAmount: this.getContractFeeReserve(slot) });
        }
        this.contractExecutionTimePerPhase.clear();
        return settlements;
    }

    private priceOf(executionTime: bigint): bigint {
        if (this.multiplierDenominator <= 0n || this.multiplierNumerator <= 0n) {
            return 0n; // core's buildExecutionFeeReportPayload reports nothing when either side of the multiplier is zero
        }
        return (executionTime * this.multiplierNumerator) / this.multiplierDenominator;
    }

    // Metered deploys seed the default reserve (a faked successful IPO) unless already funded; INITIALIZE is exempt from the gate.
    seedOnDeploy(slot: number): void {
        if (this.metered && !this.reserve.has(slot)) {
            this.reserve.set(slot, this.defaultReserve);
        }
    }

    // an index outside core's [1, contractCount) names the calling contract itself.
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
