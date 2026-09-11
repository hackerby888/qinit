// Deducing a template argument from an expression, and delivering a value back out of a call. Each row compiled and ran on both backends while answering
// differently from clang, or was refused here and compiled there. Every expectation is clang's answer, so agreeing with the other backend is not enough.
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { wasiToolchain } from "../support/container-toolchains";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

// `seed` keeps the operands out of reach of constant folding, so the argument stays a computed
// expression rather than collapsing to a literal before deduction ever sees it.
const wrap = (members: string, locals: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${members}
  struct StateData { uint64 a; uint64 seed; };
  struct Go_input {}; struct Go_output {}; struct Go_locals { ${locals} };
  PUBLIC_PROCEDURE_WITH_LOCALS(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

const CASES: Record<string, { source: string; expect: bigint }> = {
    // F203: `T` was deduced only from an addressable lvalue, a construction, or a call naming an aggregate. A computed expression matched none, `T` went
    // unbound, and sizeof(T) became 1 — so the expression hashed one truncated byte where the local hashed eight, with no diagnostic.
    "K12 of a computed expression hashes the same bytes as K12 of a local holding it": {
        source: wrap(
            "",
            "uint64 lhs; uint64 rhs; uint64 sum; id ofLocal; id ofExpression;",
            `state.mut().seed = 7;
       locals.lhs = state.get().seed;
       locals.rhs = 5;
       locals.sum = locals.lhs + locals.rhs;
       locals.ofLocal = qpi.K12(locals.sum);
       locals.ofExpression = qpi.K12(locals.lhs + locals.rhs);
       state.mut().a = (locals.ofLocal == locals.ofExpression) ? 1 : 0;`,
        ),
        expect: 1n,
    },
    // The same defect at the one width the first cut of the fix forgot: the width map listed 1, 2, 4
    // and 8, so a 16-byte operand still fell through to sizeof(T) == 1.
    "K12 of a 128-bit computed expression hashes the same bytes as K12 of a local": {
        source: wrap(
            "",
            "uint128 lhs; uint128 rhs; uint128 wide; id ofLocal; id ofExpression;",
            `state.mut().seed = 7;
       locals.lhs.low = state.get().seed; locals.lhs.high = 0;
       locals.rhs.low = 5; locals.rhs.high = 0;
       locals.wide = locals.lhs + locals.rhs;
       locals.ofLocal = qpi.K12(locals.wide);
       locals.ofExpression = qpi.K12(locals.lhs + locals.rhs);
       state.mut().a = (locals.ofLocal == locals.ofExpression) ? 1 : 0;`,
        ),
        expect: 1n,
    },
    // F215: selecting a member of a class prvalue materialises a temporary. `SELF` expands to `id(CONTRACT_INDEX, 0, 0, 0)`, so `SELF.u64._0` was an
    // unsupported member read while the same read through a one-line copy compiled. This row must compile at all, and then agree.
    "a member read straight off a constructed prvalue matches the same read through a copy": {
        source: wrap(
            "",
            "id copy;",
            `locals.copy = SELF;
       state.mut().a = (SELF.u64._0 == locals.copy.u64._0) ? 1 : 0;`,
        ),
        expect: 1n,
    },
    // A scalar in a wasm local has no address, so a `T&` parameter gets a scratch copy that must be read
    // back. `start` is a by-value parameter — exactly the storage kind the helper path used to drop.
    "a helper writing through a mutable reference to a by-value parameter is read back": {
        source: wrap(
            `static void addTo(uint64& slot, uint64 by) { slot = slot + by; }
  static uint64 accumulate(uint64 start, uint64 by) { addTo(start, by); return start; }`,
            "",
            `state.mut().a = accumulate(10, 5);`,
        ),
        expect: 15n,
    },
    // F223: an aggregate-returning call in value context materialised into scratch and then returned a scalar zero, throwing the address away; the assignment
    // ran the type's converting constructor on that zero. Only calls spelled `div` were routed through the aggregate path.
    "assigning a helper's 128-bit return stores the returned value": {
        source: wrap(
            "static uint128 widen(uint64 v) { uint128 out; out.low = v; out.high = 0; return out; }",
            "uint128 returned;",
            `state.mut().seed = 5;
       locals.returned = widen(state.get().seed);
       state.mut().a = locals.returned.low;`,
        ),
        expect: 5n,
    },
};

const runState = (wasm: Uint8Array): bigint => {
    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, wasm);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset).getBigUint64(0, true);
};

const wasiOk = wasiToolchain().available;

describe.skipIf(!HAS_CORE)("differential — template deduction and value return parity", () => {
    beforeAll(async () => {
        await initK12();
    });

    for (const [name, testCase] of Object.entries(CASES)) {
        test(
            name,
            async () => {
                const ours = await compileContractWithTypeScript({
                    source: testCase.source,
                    contractName: "DeductionProbe",
                    slot: 27,
                    qpiHeader: HEADERS(),
                    arenaSizeBytes: 1 << 20,
                });
                expect(ours.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
                expect(runState(ours.wasm)).toBe(testCase.expect);

                if (wasiOk) {
                    const directory = mkdtempSync(join(tmpdir(), "deduction-probe-"));
                    writeFileSync(join(directory, "DeductionProbe.h"), testCase.source);
                    const built = await buildContractWithClang({
                        contractPath: join(directory, "DeductionProbe.h"),
                        contractName: "DeductionProbe",
                        slot: 27,
                        corePath: CORE,
                        outDir: directory,
                        skipVerify: true,
                    });
                    expect(built.wasmPath).toBeTruthy();
                    expect(runState(new Uint8Array(readFileSync(built.wasmPath!)))).toBe(testCase.expect);
                }
            },
            180000,
        );
    }
});
