import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileContractWithTypeScript, type CompileResult } from "@qinit/compiler/browser";
import { QubicSimulator } from "../../src/qubic-simulator";

const WHO = new Uint8Array(32).fill(7);
const ARENA = 1024 * 1024;

interface Callee {
    readonly name: string;
    readonly file: string;
    readonly slot: number;
}

interface Case {
    readonly name: string;
    readonly file: string;
    readonly slot: number;
    readonly callees?: readonly Callee[];
    readonly run: (sim: QubicSimulator, slot: number) => Uint8Array[];
}

function u64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

const CASES: readonly Case[] = [
    { name: "Counter", file: "Counter.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1), sim.procedure(slot, 1), sim.query(slot, 1)] },
    { name: "Token", file: "Token.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1), sim.query(slot, 1)] },
    { name: "Vault", file: "Vault.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1), sim.query(slot, 1)] },
    // A trap has to trap at the same point, leaving the same partially-written state behind.
    { name: "Trap", file: "Trap.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1)] },
    { name: "BigState", file: "BigState.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1, u64(7n)), sim.procedure(slot, 1, u64(9n))] },
    // Overflows the journal, so the overflow branch of the injected helper runs.
    { name: "WideWrite", file: "WideWrite.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1, u64(3n)), sim.procedure(slot, 1, u64(5n))] },
    { name: "DigestProbe", file: "DigestProbe.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1)] },
    { name: "HostWrite", file: "HostWrite.h", slot: 28, run: (sim, slot) => [sim.procedure(slot, 1, undefined, { invocator: WHO, originator: WHO })] },
    {
        name: "QpiDual",
        file: "QpiDual.h",
        slot: 29,
        callees: [{ name: "QpiDualCallee", file: "QpiDualCallee.h", slot: 28 }],
        run: (sim, slot) => [sim.procedure(slot, 1), sim.query(slot, 1)],
    },
];

/** Compiles a fixture with or without the journal baked in, resolving callee IDL the same way both times. */
async function compile(entry: { file: string; name: string; slot: number }, journal: boolean, callees: readonly Callee[] = []): Promise<CompileResult> {
    const saved = process.env.QINIT_NO_STATE_JOURNAL;
    if (journal) {
        delete process.env.QINIT_NO_STATE_JOURNAL;
    } else {
        process.env.QINIT_NO_STATE_JOURNAL = "1";
    }
    try {
        const compiled = await Promise.all(callees.map((callee) => compile(callee, journal)));
        const result = await compileContractWithTypeScript({
            source: readFileSync(`fixtures/${entry.file}`, "utf8"),
            contractName: entry.name,
            slot: entry.slot,
            arenaSizeBytes: ARENA,
            ...(callees.length
                ? {
                      callees: callees.map((callee, index) => ({ ...compiled[index]!.idl!, name: callee.name, slot: callee.slot })),
                      calleeSources: callees.map((callee) => ({ name: callee.name, source: readFileSync(`fixtures/${callee.file}`, "utf8") })),
                  }
                : {}),
        });
        if (!result.wasm.byteLength) {
            throw new Error(`${entry.name} did not compile: ${JSON.stringify(result.diagnostics)}`);
        }
        return result;
    } finally {
        if (saved === undefined) {
            delete process.env.QINIT_NO_STATE_JOURNAL;
        } else {
            process.env.QINIT_NO_STATE_JOURNAL = saved;
        }
    }
}

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

function stateHex(contract: unknown): string {
    const view = contract as { mem: WebAssembly.Memory; stateAddr: number; stateSize: number };
    return hex(new Uint8Array(view.mem.buffer).slice(view.stateAddr, view.stateAddr + view.stateSize));
}

async function drive(entry: Case, journal: boolean): Promise<{ outputs: string[]; states: string[] }> {
    const sim = new QubicSimulator({ fees: "off" });
    const deployed: unknown[] = [];
    for (const callee of entry.callees ?? []) {
        deployed.push(sim.deploy(callee.slot, Uint8Array.from((await compile(callee, journal)).wasm)));
    }
    deployed.unshift(sim.deploy(entry.slot, Uint8Array.from((await compile(entry, journal, entry.callees)).wasm)));

    let outputs: string[];
    try {
        outputs = entry.run(sim, entry.slot).map(hex);
    } catch (error) {
        outputs = [`threw: ${(error as Error).message}`];
    }
    return { outputs, states: deployed.map(stateHex) };
}

// The rewrite must be invisible to the contract. Same source built both ways, same calls, and both the
// returned bytes and every byte of final state have to match — including the trap and overflow paths.
test("an instrumented contract behaves exactly like the pristine one", async () => {
    for (const entry of CASES) {
        const instrumented = await drive(entry, true);
        const pristine = await drive(entry, false);

        expect(instrumented.outputs, `${entry.name} returned different bytes`).toEqual(pristine.outputs);
        expect(instrumented.states, `${entry.name} left different state behind`).toEqual(pristine.states);
    }
});
