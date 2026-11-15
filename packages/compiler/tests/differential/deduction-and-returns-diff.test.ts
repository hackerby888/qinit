// Deducing a template argument from an expression, and delivering a value back out of a call. Each row compiled and ran on both backends while answering
// differently from clang, or was refused here and compiled there. Every expectation is clang's answer, so agreeing with the other backend is not enough.
import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { wasiToolchain } from "../support/container-toolchains";
import { runState } from "../support/parity-runner";

const CORE = CORE_PATH;
const HEADERS = () => loadQpiHeader(CORE);

// `seed` keeps the operands out of reach of constant folding, so the argument stays a computed
// expression rather than collapsing to a literal before deduction ever sees it.
const wrap = (members: string, locals: string, body: string, state = "") => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  ${members}
  struct StateData { uint64 a; uint64 seed; ${state} };
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
    // A call through a member (`qpi.tick()`, a container's `get`, a struct's own method) carried only its signedness into arithmetic and was computed at
    // 64 bits: `0u - 1u` came out as 2^64-1. Every operand below is zero, so the answers hold at any tick.
    "a qpi call keeps its declared 32-bit width in arithmetic": {
        source: wrap("", "", `state.mut().a = qpi.tick() - (qpi.tick() + 1u);`),
        expect: 4294967295n,
    },
    "a struct method's result keeps its declared width": {
        source: wrap(
            "struct Wrapped { uint32 value; uint32 get() const { return value; } };",
            "Wrapped wrapped;",
            `locals.wrapped.value = (uint32)state.get().seed;
       state.mut().a = locals.wrapped.get() - 1u;`,
        ),
        expect: 4294967295n,
    },
    "a container read in locals keeps its element width": {
        source: wrap("", "Array<uint32, 4> values;", `state.mut().a = locals.values.get(0) - 1u;`),
        expect: 4294967295n,
    },
    "a container read in state keeps its element width": {
        source: wrap("", "", `state.mut().a = state.get().values.get(0) - 1u;`, "Array<uint32, 4> values;"),
        expect: 4294967295n,
    },
    "a division helper deduces its width from a container read": {
        source: wrap("", "Array<uint32, 4> values;", `state.mut().a = QPI::div(locals.values.get(1) - 1u, 2u);`),
        expect: 2147483647n,
    },
    "auto takes the declared type of a qpi call": {
        source: wrap("", "", `auto tick = qpi.tick(); state.mut().a = tick - (tick + 1u);`),
        expect: 4294967295n,
    },
    // The same 64-bit fallback behind two more spellings: a cast written as a call, and an assignment used as a value.
    "a functional cast keeps the width it names": {
        source: wrap("", "", `state.mut().a = uint32(state.get().seed) - 1u;`),
        expect: 4294967295n,
    },
    "an assignment used as a value has its left operand's type": {
        source: wrap("", "uint32 narrow;", `state.mut().a = (locals.narrow = (uint32)state.get().seed) - 1u;`),
        expect: 4294967295n,
    },
    // `T` went unbound for a member-call argument, so this row was refused with "unknown type 'T'" while clang compiled it.
    "K12 of a qpi call hashes the same bytes as K12 of a local holding it": {
        source: wrap(
            "",
            "uint32 tick; id ofLocal; id ofExpression;",
            `locals.tick = qpi.tick();
       locals.ofLocal = qpi.K12(locals.tick);
       locals.ofExpression = qpi.K12(qpi.tick());
       state.mut().a = (locals.ofLocal == locals.ofExpression) ? 1 : 0;`,
        ),
        expect: 1n,
    },
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
                const oursState = runState(ours.wasm);
                expect(oursState.resultWord).toBe(testCase.expect);

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

                    const clangState = runState(new Uint8Array(readFileSync(built.wasmPath!)));
                    expect(clangState.stateHex).toBe(oursState.stateHex);
                    expect(clangState.resultWord).toBe(testCase.expect);
                }
            },
            180000,
        );
    }
});
