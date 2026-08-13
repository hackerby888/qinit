import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { QubicSimulator } from "../../src/qubic-simulator";
import { initK12 } from "../../src/support/k12";

function words(bytes: Uint8Array): bigint[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values: bigint[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 8) {
        values.push(view.getBigUint64(offset, true));
    }
    return values;
}

test("a trapped nested callee keeps its write and the caller recovers", async () => {
    await initK12();

    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("QpiDualCallee"));
    sim.deploy(29, await wasm("QpiDual"));
    sim.setDebug(true);

    const input = new Uint8Array(24);
    const inputView = new DataView(input.buffer);
    inputView.setBigUint64(0, 5n, true);
    inputView.setBigUint64(8, 3n, true);
    inputView.setBigInt64(16, -1n, true);

    const output = sim.procedure(29, 2, input);

    expect(words(output)).toEqual([0n, 0n, 7n, 12n, 15n, 2n]);
    expect(sim.isFaulted()).toBe(false);

    const trace = sim.getTrace().entries;
    const trapped = trace.find(
        (entry) => entry.index === 28 && entry.kind === 1 && entry.entry === 2,
    );
    expect(trapped).toMatchObject({ ok: false });
    expect(trapped?.trap).toMatch(/overflow/i);
    expect(trapped?.stateDiff).toEqual([
        {
            off: 0,
            before: "07000000000000000000000000000000415745454c4c4143",
            after: "0c000000000000000100000000000000415745454c4c4143",
        },
    ]);

    const caller = trace.find(
        (entry) => entry.index === 29 && entry.kind === 1 && entry.entry === 2,
    );
    expect(caller?.ok).toBe(true);
    expect(caller?.hostCalls.map((call) => call.name)).toEqual([
        "callFunction",
        "invokeProcedure",
        "callFunction",
        "invokeProcedure",
        "callFunction",
    ]);
    expect(caller?.hostCalls[1]?.detail).not.toContain("err");

    expect(words(sim.query(28, 1))).toEqual([15n, 2n, 0x43414c4c45455741n]);
    expect(words(sim.query(29, 1)).slice(-6, -2)).toEqual([0n, 15n, 2n, 1n]);
});

test("a trapped nested function returns zero output and remains callable", async () => {
    await initK12();

    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("QpiDualCallee"));
    sim.deploy(29, await wasm("QpiDual"));
    sim.setDebug(true);

    const input = new Uint8Array(8);
    new DataView(input.buffer).setBigInt64(0, -1n, true);
    const result = sim.doCallFunction(29, 28, 2, input, new Uint8Array(32));

    expect(result.error).toBe(0);
    expect(words(result.output)).toEqual([0n]);

    const trapped = sim
        .getTrace()
        .entries.find((entry) => entry.index === 28 && entry.kind === 0 && entry.entry === 2);
    expect(trapped).toMatchObject({ ok: false });
    expect(trapped?.trap).toMatch(/overflow/i);
    expect(trapped?.stateDiff).toEqual([]);
    expect(words(sim.query(28, 1))).toEqual([7n, 0n, 0x43414c4c45455741n]);
    expect(sim.isFaulted()).toBe(false);
});
