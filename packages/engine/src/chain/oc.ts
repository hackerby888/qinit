import { OC_INTERFACES } from "../oc-interfaces/registry";
import {
    encodeOcInvocationStatusChangeLog,
    MAX_OC_IN_FLIGHT_INVOCATIONS,
    MAX_OC_INVOCATIONS_PER_EPOCH,
    MAX_OC_REQUEST_SIZE,
    MIN_OC_INVOCATION_FEE,
    OC_AUTH_SIGNATURE_PUBLICATION_OFFSET,
    OC_INVOCATION_STATUS,
    OC_INVOCATION_TIMEOUT_DEFAULT_TICKS,
    OC_REQUEST_STORAGE_SIZE,
    QUBIC_LOG_TYPE,
    TXS_PER_TICK,
} from "@qinit/proto";

export { OC_INVOCATION_STATUS };

interface OcInvocationRec {
    id: bigint;
    slot: number;
    interfaceIndex: number;
    requestSize: number;
    status: number;
    creationTick: number;
    // core holds an in-flight slot from the call until the bundle's single delivery attempt, and admission control counts it.
    holdsInFlight: boolean;
}

export interface OcHost {
    energyOf(slot: number): bigint;
    decreaseEnergyOf(slot: number, amount: bigint): void;
    refundEnergyOf(slot: number, amount: bigint): void;
    currentTick(): number;
    log?(type: number, message: Uint8Array): void;
}

export class OcManager {
    private readonly host: OcHost;
    private invocations = new Map<bigint, OcInvocationRec>();
    private inFlight = 0;
    private requestStorageBytesUsed = 0;
    private idTick = -1;
    private indexInTick = TXS_PER_TICK;

    constructor(host: OcHost) {
        this.host = host;
    }

    startContractInvocation(slot: number, interfaceIndex: number, request: Uint8Array): bigint {
        const ocInterface = OC_INTERFACES[interfaceIndex];
        if (!ocInterface || request.length !== ocInterface.request.SIZE || request.length > MAX_OC_REQUEST_SIZE) {
            return -1n;
        }

        const fee = ocInterface.getInvocationFee(request);
        if (fee < MIN_OC_INVOCATION_FEE || this.host.energyOf(slot) < fee) {
            return -1n;
        }

        // core charges before the engine records, then refunds when the engine refuses, so both orders are visible in the log stream.
        this.host.decreaseEnergyOf(slot, fee);
        const id = this.record(slot, interfaceIndex, request.length);
        if (id < 0n) {
            this.host.refundEnergyOf(slot, fee);
        }
        return id;
    }

    private record(slot: number, interfaceIndex: number, requestSize: number): bigint {
        const full =
            this.invocations.size >= MAX_OC_INVOCATIONS_PER_EPOCH ||
            this.inFlight >= MAX_OC_IN_FLIGHT_INVOCATIONS ||
            this.requestStorageBytesUsed + requestSize > OC_REQUEST_STORAGE_SIZE;
        if (full) {
            return -1n;
        }

        const id = this.newInvocationId();
        if (id < 0n) {
            return -1n;
        }

        const invocation: OcInvocationRec = {
            id,
            slot,
            interfaceIndex,
            requestSize,
            status: OC_INVOCATION_STATUS.PENDING_AUTH,
            creationTick: this.host.currentTick(),
            holdsInFlight: true,
        };
        this.invocations.set(id, invocation);
        this.inFlight++;
        this.requestStorageBytesUsed += requestSize;
        this.logStatusChange(invocation);
        return id;
    }

    // core's id is the tick in the high bits and a per-tick counter that starts past the tick's transactions in the low bits.
    private newInvocationId(): bigint {
        const tick = this.host.currentTick();
        if (this.idTick < tick) {
            this.idTick = tick;
            this.indexInTick = TXS_PER_TICK;
        } else {
            if (this.indexInTick >= 0x7fffffff) return -1n;
            this.indexInTick++;
        }
        return (BigInt(tick) << 31n) | BigInt(this.indexInTick);
    }

    private logStatusChange(invocation: OcInvocationRec): void {
        this.host.log?.(
            QUBIC_LOG_TYPE.OC_INVOCATION_STATUS_CHANGE,
            encodeOcInvocationStatusChangeLog(invocation.id, invocation.slot, invocation.interfaceIndex, invocation.status),
        );
    }

    // one tick of the engine: the computors' authorization signatures land, then timeouts, then the single delivery attempt.
    pump(): void {
        const tick = this.host.currentTick();

        for (const invocation of this.invocations.values()) {
            if (invocation.status !== OC_INVOCATION_STATUS.PENDING_AUTH) continue;
            if (tick - invocation.creationTick < OC_AUTH_SIGNATURE_PUBLICATION_OFFSET) continue;

            invocation.status = OC_INVOCATION_STATUS.AUTHORIZED;
            this.logStatusChange(invocation);
        }

        for (const invocation of this.invocations.values()) {
            if (invocation.status !== OC_INVOCATION_STATUS.PENDING_AUTH) continue;
            if (tick - invocation.creationTick < OC_INVOCATION_TIMEOUT_DEFAULT_TICKS) continue;

            invocation.status = OC_INVOCATION_STATUS.TIMEOUT;
            this.releaseInFlight(invocation);
            this.logStatusChange(invocation);
        }

        // the slot is freed on the delivery tick even with no OC machine peers, because admission control depends on it.
        for (const invocation of this.invocations.values()) {
            if (invocation.status === OC_INVOCATION_STATUS.AUTHORIZED) this.releaseInFlight(invocation);
        }
    }

    private releaseInFlight(invocation: OcInvocationRec): void {
        if (!invocation.holdsInFlight) {
            return;
        }

        invocation.holdsInFlight = false;
        this.inFlight--;
    }

    beginEpoch(): void {
        this.invocations.clear();
        this.inFlight = 0;
        this.requestStorageBytesUsed = 0;
        this.idTick = -1;
        this.indexInTick = TXS_PER_TICK;
    }

    getOcInvocationStatus(invocationId: bigint): number {
        return this.invocations.get(invocationId)?.status ?? OC_INVOCATION_STATUS.UNKNOWN;
    }
}
