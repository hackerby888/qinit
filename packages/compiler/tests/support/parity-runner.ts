// Running one probe contract through both compilers — ours in the simulator, Clang's from the same source — so an expected value cannot be wrong in both.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "bun:test";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { CORE_PATH } from "../../../../test-utils/paths";

export const PARITY_SLOT = 27;
export const PARITY_ARENA_BYTES = 1 << 20;

export interface ProbeState {
    // where every probe folds its answer, so a pinned value stays one readable number.
    resultWord: bigint;
    // every byte of state: two compilers are compared on all of it, not on the answer alone.
    stateHex: string;
}

/** Deploy, invoke the single registered procedure, and read back the state it left. */
export function runState(wasm: Uint8Array): ProbeState {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);

    simulator.fund(user, 1_000_000n);
    simulator.deploy(PARITY_SLOT, wasm);
    simulator.procedure(PARITY_SLOT, 1, undefined, { invocator: user });

    const state = simulator.contracts.get(PARITY_SLOT)!.state();

    return {
        resultWord: new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true),
        stateHex: Buffer.from(state).toString("hex"),
    };
}

export async function clangState(name: string, source: string, tempPrefix: string): Promise<ProbeState> {
    const directory = mkdtempSync(join(tmpdir(), `${tempPrefix}-${name}-`));

    try {
        const contractPath = join(directory, `${name}.h`);
        writeFileSync(contractPath, source);

        const built = await buildContractWithClang({
            contractPath,
            contractName: name,
            slot: PARITY_SLOT,
            corePath: CORE_PATH,
            outDir: directory,
            arenaSizeBytes: PARITY_ARENA_BYTES,
            skipVerify: true,
        });
        expect(built.ok).toBe(true);

        return runState(new Uint8Array(readFileSync(built.wasmPath!)));
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
