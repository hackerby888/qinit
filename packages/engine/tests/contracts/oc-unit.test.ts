import { expect, test } from "bun:test";
import { OcManager, OC_INVOCATION_STATUS, type OcHost } from "../../src/chain/oc";
import { OcRequest as MockOcRequest } from "../../src/oc-interfaces/mock";
import { OC_INVOCATION_TIMEOUT_DEFAULT_TICKS, OcInvocationStatusChange, QUBIC_LOG_TYPE, TXS_PER_TICK } from "@qinit/proto";

interface LogRecord {
    type: number;
    message: Uint8Array;
}

function fakeHost(): OcHost & { balances: Map<number, bigint>; logs: LogRecord[]; tick: number } {
    const balances = new Map<number, bigint>();
    const logs: LogRecord[] = [];
    const host = {
        balances,
        logs,
        tick: 1000,
        energyOf: (slot: number) => balances.get(slot) ?? 0n,
        decreaseEnergyOf: (slot: number, amount: bigint) => balances.set(slot, (balances.get(slot) ?? 0n) - amount),
        refundEnergyOf: (slot: number, amount: bigint) => balances.set(slot, (balances.get(slot) ?? 0n) + amount),
        currentTick: () => host.tick,
        log: (type: number, message: Uint8Array) => logs.push({ type, message: message.slice() }),
    };
    return host;
}

function mockRequest(value: bigint): Uint8Array {
    const request = MockOcRequest.alloc();
    request.value = value;
    return request.bytes;
}

// run the engine's per-tick pass the given number of ticks, as the simulator's tick loop does.
function advance(host: { tick: number }, oc: OcManager, ticks: number): void {
    for (let i = 0; i < ticks; i++) {
        host.tick++;
        oc.pump();
    }
}

test("an invocation charges the fee, then reaches authorized after the signature offset", () => {
    const host = fakeHost();
    const oc = new OcManager(host);
    host.balances.set(29, 100n);

    const id = oc.startContractInvocation(29, 0, mockRequest(42n));
    expect(id).toBeGreaterThan(0n);
    expect(host.balances.get(29)).toBe(90n);
    expect(oc.getOcInvocationStatus(id)).toBe(OC_INVOCATION_STATUS.PENDING_AUTH);

    // core schedules the authorization signatures three ticks out, so the status only moves then.
    advance(host, oc, 2);
    expect(oc.getOcInvocationStatus(id)).toBe(OC_INVOCATION_STATUS.PENDING_AUTH);
    advance(host, oc, 1);
    expect(oc.getOcInvocationStatus(id)).toBe(OC_INVOCATION_STATUS.AUTHORIZED);

    // it stays authorized: an oc invocation has no reply to wait for.
    advance(host, oc, OC_INVOCATION_TIMEOUT_DEFAULT_TICKS + 1);
    expect(oc.getOcInvocationStatus(id)).toBe(OC_INVOCATION_STATUS.AUTHORIZED);
});

test("the invocation id carries the tick and a counter past the tick's transactions", () => {
    const host = fakeHost();
    const oc = new OcManager(host);
    host.balances.set(29, 1000n);

    const first = oc.startContractInvocation(29, 0, mockRequest(1n));
    const second = oc.startContractInvocation(29, 0, mockRequest(2n));
    expect(first).toBe((BigInt(host.tick) << 31n) | BigInt(TXS_PER_TICK));
    expect(second).toBe(first + 1n);

    host.tick++;
    const next = oc.startContractInvocation(29, 0, mockRequest(3n));
    expect(next).toBe((BigInt(host.tick) << 31n) | BigInt(TXS_PER_TICK));
});

test("a bad interface, a wrong request size or too little balance is refused without charging", () => {
    const host = fakeHost();
    const oc = new OcManager(host);
    host.balances.set(29, 9n);

    expect(oc.startContractInvocation(29, 1, mockRequest(1n))).toBe(-1n);
    expect(oc.startContractInvocation(29, 0, new Uint8Array(4))).toBe(-1n);
    // the mock fee is 10, so nine qus is not enough.
    expect(oc.startContractInvocation(29, 0, mockRequest(1n))).toBe(-1n);
    expect(host.balances.get(29)).toBe(9n);
    expect(host.logs).toEqual([]);
});

test("each status change is logged as core's record", () => {
    const host = fakeHost();
    const oc = new OcManager(host);
    host.balances.set(29, 100n);

    const id = oc.startContractInvocation(29, 0, mockRequest(7n));
    advance(host, oc, 3);

    expect(host.logs.map((record) => record.type)).toEqual([QUBIC_LOG_TYPE.OC_INVOCATION_STATUS_CHANGE, QUBIC_LOG_TYPE.OC_INVOCATION_STATUS_CHANGE]);
    expect(host.logs.every((record) => record.message.length === OcInvocationStatusChange.OFFSETS._terminator)).toBe(true);

    const authorized = OcInvocationStatusChange.wrap(host.logs[1].message);
    expect({ id: authorized.invocationId, slot: authorized.contractIndex, iface: authorized.interfaceIndex, status: authorized.status }).toEqual({
        id,
        slot: 29,
        iface: 0,
        status: OC_INVOCATION_STATUS.AUTHORIZED,
    });
});

test("an epoch drops every record, so a previous epoch's id reads unknown", () => {
    const host = fakeHost();
    const oc = new OcManager(host);
    host.balances.set(29, 100n);

    const id = oc.startContractInvocation(29, 0, mockRequest(5n));
    advance(host, oc, 3);
    expect(oc.getOcInvocationStatus(id)).toBe(OC_INVOCATION_STATUS.AUTHORIZED);

    oc.beginEpoch();
    expect(oc.getOcInvocationStatus(id)).toBe(OC_INVOCATION_STATUS.UNKNOWN);
});

test("an unknown id reads unknown", () => {
    const oc = new OcManager(fakeHost());
    expect(oc.getOcInvocationStatus(424242n)).toBe(OC_INVOCATION_STATUS.UNKNOWN);
});
