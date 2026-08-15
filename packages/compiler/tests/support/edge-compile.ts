// Shared compile helpers for the edge-audit suites, which all build one probe contract at slot 27 and
// differ only in the contract name.
import { CORE_PATH } from "../../../../test-utils/paths";
import { expect } from "bun:test";
import { QubicSimulator } from "@qinit/engine";
import { compileContract, loadQpiHeader, type CompileResult } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";

const HEADERS = loadQpiHeader(CORE_PATH);
const PROBE_SLOT = 27;
const PROBE_ARENA_BYTES = 1 << 20;

export function edgeCompiler(contractName: string): (source: string) => Promise<CompileResult> {
    return (source: string) =>
        compileContract({
            source,
            contractName,
            slot: PROBE_SLOT,
            qpiHeader: HEADERS,
            arenaSizeBytes: PROBE_ARENA_BYTES,
        });
}

// Compiles, deploys, runs procedure 1, and answers with the first uint64 of the resulting state — the
// value the edge suites assert on.
export function edgeRunner(contractName: string): (source: string) => Promise<bigint> {
    const compile = edgeCompiler(contractName);

    return async (source: string) => {
        const result = await compile(source);
        expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        expect(WebAssembly.validate(result.wasm)).toBe(true);

        const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
        const user = new Uint8Array(32).fill(7);
        simulator.fund(user, 1_000_000n);
        simulator.deploy(PROBE_SLOT, result.wasm);
        simulator.procedure(PROBE_SLOT, 1, undefined, { invocator: user });

        const state = simulator.contracts.get(PROBE_SLOT)!.state();
        return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
    };
}
