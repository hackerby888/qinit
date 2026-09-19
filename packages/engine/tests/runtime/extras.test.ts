// The last host imports: spectrum iteration (nextId/prevId) and shareholder governance (setShareholderProposal into the callee's sysproc).
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";

function hex(b: Uint8Array): string {
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const ID = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const ZERO = new Uint8Array(32);

test("nextId / prevId iterate the occupied spectrum entities", async () => {
    await initK12();

    const sim = new QubicSimulator();
    const A = ID(0x11),
        B = ID(0x22),
        C = ID(0x33);
    sim.fund(A, 1n);
    sim.fund(B, 1n);
    sim.fund(C, 1n);

    expect(hex(sim.nextId(A))).toBe(hex(B));
    expect(hex(sim.nextId(B))).toBe(hex(C));
    expect(hex(sim.nextId(C))).toBe(hex(ZERO)); // none after
    expect(hex(sim.prevId(C))).toBe(hex(B));
    expect(hex(sim.prevId(A))).toBe(hex(ZERO)); // none before
});

test("nextId via the wasm host import (Token.NextId)", async () => {
    await initK12();

    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("Token"));
    const A = ID(0x44),
        B = ID(0x55);
    sim.fund(A, 1n);
    sim.fund(B, 1n);

    const out = sim.query(28, 4, A); // Token.NextId(cur=A) -> qpi.nextId -> host.nextId
    expect(hex(out)).toBe(hex(B));
});

test("governance: setShareholderProposal invokes the callee's SET_SHAREHOLDER_PROPOSAL", async () => {
    await initK12();

    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("ShareReceiver")); // callee (defines SET_SHAREHOLDER_PROPOSAL)
    sim.deploy(29, await wasm("ShareProposer")); // caller

    const input = new Uint8Array(2); // ShareProposer Propose_input { uint16 target }
    new DataView(input.buffer).setUint16(0, 28, true);
    sim.procedure(29, 1, input); // ShareProposer.Propose(target=28) -> ShareReceiver SET_SHAREHOLDER_PROPOSAL

    const out = sim.query(28, 1); // ShareReceiver.GetLast -> { uint64 byte0; uint64 count }
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(dv.getBigUint64(0, true)).toBe(222n); // the proposal's first byte (ShareProposer writes 222)
    expect(dv.getBigUint64(8, true)).toBe(1n); // callback count
});

test("governance guards: callee lacks the sysproc + self-call -> INVALID_PROPOSAL_INDEX", async () => {
    await initK12();

    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("Counter")); // no SET_SHAREHOLDER_PROPOSAL
    sim.deploy(29, await wasm("ShareProposer"));
    const ORIG = new Uint8Array(32);
    const PROP = new Uint8Array(1024);

    expect(sim.setShareholderProposal(29, 28, PROP, 0n, ORIG)).toBe(0xffff); // callee lacks the sysproc
    expect(sim.setShareholderProposal(28, 28, PROP, 0n, ORIG)).toBe(0xffff); // self-call
});

const proposeInput = (target: number): Uint8Array => {
    const input = new Uint8Array(2);
    new DataView(input.buffer).setUint16(0, target, true);
    return input;
};

const words = (bytes: Uint8Array): bigint[] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: bytes.length >> 3 }, (_, index) => view.getBigUint64(index * 8, true));
};

// The callback path is core's __qpiCallSystemProc: no fee gate, a re-entry guard, and an abort for a callee that is out of service.
test("governance: proposal and votes reach the callee and return its answer", async () => {
    await initK12();

    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("ShareReceiver"));
    sim.deploy(29, await wasm("ShareProposer"));
    // A system callback skips the fee check, so a callee with nothing in reserve still answers.
    sim.setContractFeeReserve(28, 0n);

    sim.procedure(29, 1, proposeInput(28));
    sim.procedure(29, 2, proposeInput(28));

    // byte0, proposals, votes, the vote's proposal index, and the refused call back into the proposer.
    expect(words(sim.query(28, 1))).toEqual([222n, 1n, 1n, 7n, 0xffffn]);
    expect(words(sim.query(29, 1))).toEqual([7n, 1n]);
});

test("governance guards: every refused input returns the default", async () => {
    await initK12();

    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("ShareReceiver"));
    sim.deploy(29, await wasm("ShareProposer"));
    const originator = new Uint8Array(32);
    const proposal = new Uint8Array(1024);
    const vote = new Uint8Array(104);

    for (const [callee, reward] of [
        [29, 0n],
        [0, 0n],
        [28, -1n],
    ] as const) {
        expect(sim.setShareholderProposal(29, callee, proposal, reward, originator)).toBe(0xffff);
        expect(sim.setShareholderVotes(29, callee, vote, reward, originator)).toBe(0);
    }
    expect(sim.setShareholderVotes(29, 27, vote, 0n, originator)).toBe(0);
    expect(words(sim.query(28, 1))[1]).toBe(0n);

    // A callee at or past core's contract count is refused even though it defines the callback.
    const bounded = new QubicSimulator({ contractCount: 28 });
    bounded.deploy(28, await wasm("ShareReceiver"));
    bounded.deploy(29, await wasm("ShareProposer"));
    expect(bounded.setShareholderProposal(29, 28, proposal, 0n, originator)).toBe(0xffff);
    expect(words(bounded.query(28, 1))[1]).toBe(0n);
});

test("governance: a callee out of service aborts the caller instead of answering", async () => {
    await initK12();

    const failedIpo = new QubicSimulator({ haltOnContractFault: false });
    failedIpo.deploy(28, await wasm("ShareReceiver"));
    failedIpo.deploy(29, await wasm("ShareProposer"));
    failedIpo.ipo(28, 0n);
    expect(() => failedIpo.procedure(29, 1, proposeInput(28))).toThrow(/abort\(8\)/);
    expect(words(failedIpo.query(28, 1))[1]).toBe(0n);

    const inactive = new QubicSimulator({ haltOnContractFault: false });
    inactive.deploy(28, await wasm("ShareReceiver"));
    inactive.deploy(29, await wasm("ShareProposer"));
    inactive.setContractLifetime(28, 5, 10);
    expect(() => inactive.procedure(29, 2, proposeInput(28))).toThrow(/abort\(4\)/);

    inactive.currentEpoch = 5;
    inactive.procedure(29, 2, proposeInput(28));
    expect(words(inactive.query(28, 1))[2]).toBe(1n);
});
