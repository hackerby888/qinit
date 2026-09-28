// Shared compile helpers for the edge-audit suites, which all build one probe contract at slot 27 and differ only in the contract name.
import { CORE_PATH } from "../../../../test-utils/paths";
import { expect } from "bun:test";
import { compileContractWithTypeScript, loadQpiHeader, type CompileResult } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { clangState, PARITY_ARENA_BYTES, PARITY_SLOT, runState, type ProbeState } from "./parity-runner";

const HEADERS = () => loadQpiHeader(CORE_PATH);

export function edgeCompiler(contractName: string): (source: string) => Promise<CompileResult> {
    return (source: string) =>
        compileContractWithTypeScript({
            source,
            contractName,
            slot: PARITY_SLOT,
            qpiHeader: HEADERS(),
            arenaSizeBytes: PARITY_ARENA_BYTES,
        });
}

// compiles, deploys, runs procedure 1, and answers with every byte of the state it left.
export function edgeProbe(contractName: string): (source: string) => Promise<ProbeState> {
    const compile = edgeCompiler(contractName);

    return async (source: string) => {
        const result = await compile(source);
        expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        expect(WebAssembly.validate(result.wasm)).toBe(true);

        return runState(result.wasm);
    };
}

// word 0 stands for a probe only while it is the whole state; a wider probe pins every word through edgeWords.
export function soleWord(state: Uint8Array): bigint {
    expect(state.byteLength).toBe(8);

    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

export function edgeRunner(contractName: string): (source: string) => Promise<bigint> {
    const probe = edgeProbe(contractName);

    return async (source: string) => soleWord(Buffer.from((await probe(source)).stateHex, "hex"));
}

// every uint64 of the state, so what a probe writes past word 0 is pinned too.
export function edgeWords(contractName: string): (source: string) => Promise<bigint[]> {
    const probe = edgeProbe(contractName);

    return async (source: string) => {
        const state = Buffer.from((await probe(source)).stateHex, "hex");
        const view = new DataView(state.buffer, state.byteOffset, state.byteLength);

        return Array.from({ length: state.byteLength / 8 }, (_, index) => view.getBigUint64(index * 8, true));
    };
}

// a container state is too big to pin by hand, so clang builds the same source and the whole state must hash the same.
export function edgeClangRunner(contractName: string): (source: string) => Promise<bigint> {
    const probe = edgeProbe(contractName);

    return async (source: string) => {
        const ours = await probe(source);
        const clang = await clangState(contractName, source, "edge");
        expect(ours.digest).toBe(clang.digest);

        return ours.resultWord;
    };
}
