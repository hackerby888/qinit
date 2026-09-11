// Replaying one call script against one wasm artifact in the in-process simulator.

import { QubicSimulator } from "@qinit/engine";
import type { BackendRun, CallScript, StepRecord } from "./types";
import { bytesToHex, hexToBytes } from "./encode";

/** Fixed stand-in for the previous spectrum digest, so `qpi.getPrevSpectrumDigest()` is reproducible. */
const PINNED_SPECTRUM_DIGEST = new Uint8Array(32).fill(0x5a);

/** The simulator builds a fresh committee per instance, so an unpinned `qpi.computor(i)` differs between
 *  two runs of the same backend. These stand-ins mean nothing beyond being fixed and distinct. */
const PINNED_COMPUTOR_COUNT = 676;

function pinCommittee(sim: QubicSimulator): void {
    for (let index = 0; index < PINNED_COMPUTOR_COUNT; index++) {
        const key = new Uint8Array(32);
        key[0] = 0xc0;
        key[1] = index & 0xff;
        key[2] = (index >> 8) & 0xff;
        key[31] = 0x0c;
        sim.setComputorKey(index, key);
    }
}

/** A simulator error message that means the entry was refused, rather than the contract trapping. */
function isRejection(message: string): boolean {
    return /reject|invalid|unknown contract|not found|unregistered/i.test(message);
}

/** A callee deployed alongside the contract under test, at a strictly lower slot. */
export interface DeployedCallee {
    slot: number;
    wasm: Uint8Array;
}

export function executeScript(backend: BackendRun["backend"], wasm: Uint8Array, script: CallScript, callee?: DeployedCallee): BackendRun {
    const started = Date.now();
    const steps: StepRecord[] = [];
    const sim = new QubicSimulator({
        mempool: false,
        fees: "off",
        liteTicking: true,
        // DEFAULT_EPOCH_LENGTH is 3000, so a script would never reach END_EPOCH without shortening it.
        epochLength: script.epochLength,
    });
    sim.currentTick = script.tick;
    sim.currentEpoch = script.epoch;
    sim.prevSpectrumDigestOverride = PINNED_SPECTRUM_DIGEST;
    // The simulator's clock is `timeBaseMs + tick * tickDuration`, and its default base is already a constant; setting it here says so out loud, because every
    // date and time host call is derived from it and a wall-clock default would make the whole date family non-reproducible.
    sim.timeBaseMs = Date.UTC(2024, 0, 1);
    pinCommittee(sim);
    // Logs are only captured into the debug trace when debug is on, and a log divergence is one of the
    // cheapest signals a codegen difference produces.
    sim.setDebug(true);

    const identities = script.identities.map((hex) => hexToBytes(hex));
    for (const entry of script.fund) sim.fund(identities[entry.id], BigInt(entry.amount));

    let status: BackendRun["status"] = "ok";
    let fatal: string | undefined;
    try {
        // Ascending by slot: the registry runs INITIALIZE on first deploy, so a caller whose INITIALIZE
        // calls out would otherwise hit an empty slot and get CALL_ERROR_CONTRACT_INACTIVE.
        if (callee) sim.deploy(callee.slot, callee.wasm);
        sim.deploy(script.slot, wasm);
    } catch (error: any) {
        const message = String(error?.message ?? error);
        return {
            backend,
            status: isRejection(message) ? "rejected" : "trap",
            steps,
            diagnostics: [`deploy: ${message}`],
            compileMs: 0,
            executeMs: Date.now() - started,
        };
    }

    for (const [index, step] of script.steps.entries()) {
        const record: StepRecord = { index, kind: step.kind, entry: step.entry };
        try {
            switch (step.kind) {
                case "procedure": {
                    const input = step.in ? hexToBytes(step.in) : undefined;
                    const output = sim.procedure(script.slot, step.entry!, input, {
                        invocator: identities[step.invocator ?? 0],
                        ...(step.amount ? { reward: BigInt(step.amount) } : {}),
                    });
                    record.out = bytesToHex(output);
                    break;
                }
                case "function": {
                    const input = step.in ? hexToBytes(step.in) : undefined;
                    record.out = bytesToHex(sim.query(script.slot, step.entry!, input));
                    break;
                }
                case "advanceTick": {
                    for (let i = 0; i < (step.n ?? 1); i++) sim.advance();
                    break;
                }
                case "advanceEpoch": {
                    for (let i = 0; i < (step.n ?? 1); i++) sim.endEpoch();
                    break;
                }
            }
            record.logs = (sim.getTrace().entries.at(-1)?.logs ?? []).map((log: { type: number; hex: string }) => `${log.type}:${log.hex}`);
        } catch (error: any) {
            const message = String(error?.message ?? error);
            record.fault = message;
            steps.push(record);
            // A trap ends the run: continuing would compare states that diverged for a known reason.
            status = isRejection(message) ? "rejected" : "trap";
            fatal = message;
            break;
        }
        record.digest = sim.digest(script.slot);
        steps.push(record);
    }

    const contract = sim.contracts.get(script.slot);
    const finalState = contract?.state();
    const calleeContract = callee ? sim.contracts.get(callee.slot) : undefined;
    return {
        backend,
        status,
        digest: contract ? sim.digest(script.slot) : undefined,
        stateSize: finalState?.byteLength,
        statePrefix: finalState ? bytesToHex(finalState.slice(0, 32)) : undefined,
        stateSuffix: finalState ? bytesToHex(finalState.slice(Math.max(0, finalState.byteLength - 32))) : undefined,
        steps,
        ...(fatal ? { diagnostics: [fatal] } : {}),
        compileMs: 0,
        executeMs: Date.now() - started,
        wasmBytes: wasm.byteLength,
        // Most cross-contract mutation lands in the callee, so the caller's own state can be identical
        // while the callee's diverges. Both are compared.
        ...(calleeContract ? { calleeDigest: sim.digest(callee!.slot), calleeStateSize: calleeContract.state().byteLength } : {}),
    };
}
