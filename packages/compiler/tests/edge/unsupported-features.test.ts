import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Ensures each unsupported-feature tier fails, or survives, the strict gate as intended.
import { describe, expect, test } from "bun:test";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const HEADERS = () => loadQpiHeader(CORE_PATH);

await initK12();

// Deploy, drive procedure 1, and read the first state word.
function runProcedureStateWord(wasm: Uint8Array): bigint {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, wasm);
    sim.procedure(27, 1, new Uint8Array(32), { invocator: user });
    const state = new Uint8Array(sim.contracts.get(27)!.state());
    return new DataView(state.buffer, state.byteOffset).getBigUint64(0, true);
}

// Native C spellings lower correctly at their wasm32 widths, so they must not fail a strict build.
const NATIVE_C_SRC = `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 x;
  };

  struct Probe_input {
    uint64 seed;
  };
  struct Probe_output {
    uint64 v;
  };
  PUBLIC_FUNCTION(Probe)
  {
    int counter = 3;
    char small = 5;
    long wide = 7;
    unsigned int positive = 11;
    output.v = counter + small + wide + positive + input.seed;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
  {
    REGISTER_USER_FUNCTION(Probe, 1);
  }
};
`;

describe.skipIf(!HAS_CORE)("native C scalar types are advisory, not fatal", () => {
    test("compiles under default strict and warns without erroring", async () => {
        const result = await compileContractWithTypeScript({
            source: NATIVE_C_SRC,
            contractName: "NativeCProbe",
            slot: 28,
            qpiHeader: HEADERS(),
        });

        const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
        const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.WARNING);

        expect(errors).toEqual([]);
        expect(result.wasm.length).toBeGreaterThan(0);
        expect(warnings.some((diagnostic) => /non-canonical native C type 'int'/.test(diagnostic.message))).toBe(true);
        expect(warnings.some((diagnostic) => /non-canonical native C type 'char'/.test(diagnostic.message))).toBe(true);
    });

    // The advisory is only correct if it rides a channel strict mode leaves alone, so pin the category.
    test("the advisory carries no category, which is what keeps strict from promoting it", async () => {
        const result = await compileContractWithTypeScript({
            source: NATIVE_C_SRC,
            contractName: "NativeCProbe",
            slot: 28,
            qpiHeader: HEADERS(),
        });

        const advisories = result.diagnostics.filter((diagnostic) => /non-canonical native C type/.test(diagnostic.message));

        expect(advisories.length).toBeGreaterThan(0);
        expect(advisories.every((diagnostic) => diagnostic.category === undefined)).toBe(true);
    });

    // A type used repeatedly should report once, not once per declaration.
    test("deduplicates per spelling and line", async () => {
        const result = await compileContractWithTypeScript({
            source: NATIVE_C_SRC,
            contractName: "NativeCProbe",
            slot: 28,
            qpiHeader: HEADERS(),
        });

        const messages = result.diagnostics.filter((d) => /non-canonical native C type/.test(d.message)).map((d) => `${d.message}@${d.span.line}`);

        expect(new Set(messages).size).toBe(messages.length);
    });
});

// A destructor body never runs: no scope-exit lowering exists, and both declaration indexes drop
// `~`-named functions outright.
const destructorContract = (body: string) => `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Guard {
    uint64 mark;
    ~Guard() {${body}}
  };
  struct StateData { uint64 x; };
  struct Probe_input { uint64 seed; };
  struct Probe_output { uint64 v; };
  PUBLIC_FUNCTION(Probe) { output.v = input.seed; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Probe, 1); }
};
`;

const compileDestructor = async (body: string) => {
    const result = await compileContractWithTypeScript({
        source: destructorContract(body),
        contractName: "DestructorProbe",
        slot: 28,
        qpiHeader: HEADERS(),
    });
    return {
        wasm: result.wasm,
        errors: result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR),
    };
};

describe.skipIf(!HAS_CORE)("a destructor with a body is refused, not dropped", () => {
    test("names the feature and points at clang", async () => {
        const { wasm, errors } = await compileDestructor(" mark = 999; ");

        expect(wasm.length).toBe(0);
        expect(errors.some((diagnostic) => /unsupported destructor '~Guard'/.test(diagnostic.message))).toBe(true);
        expect(errors.some((diagnostic) => /build this contract with clang/.test(diagnostic.message))).toBe(true);
    });

    // The old failure was a parser fidelity warning about a stray token, which named neither the
    // construct nor the remedy. Guard against regressing to it.
    test("no longer reports an unparseable token", async () => {
        const { errors } = await compileDestructor(" mark = 999; ");

        expect(errors.some((diagnostic) => /skipped unparseable token/.test(diagnostic.message))).toBe(false);
    });

    // An empty destructor really is a no-op, so refusing it would be over-rejection.
    test("an empty destructor still compiles", async () => {
        const { wasm, errors } = await compileDestructor(" ");

        expect(errors).toEqual([]);
        expect(wasm.length).toBeGreaterThan(0);
    });
});

// A token the declaration parser cannot model used to be a fidelity warning that skipped one token and
// let the rest re-parse as something else. Not knowing what the code says is a parse error.
describe.skipIf(!HAS_CORE)("an unparseable declaration is a parse error", () => {
    const withMember = (member: string) => `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  ${member}
  struct StateData { uint64 x; };
  struct Probe_input { uint64 seed; };
  struct Probe_output { uint64 v; };
  PUBLIC_FUNCTION(Probe) { output.v = input.seed; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Probe, 1); }
};
`;

    const compileMember = async (member: string) => {
        const result = await compileContractWithTypeScript({
            source: withMember(member),
            contractName: "ParseProbe",
            slot: 28,
            qpiHeader: HEADERS(),
        });
        return {
            wasm: result.wasm,
            errors: result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR),
        };
    };

    test("names the token and points at clang", async () => {
        const { wasm, errors } = await compileMember("% uint64 v;");

        expect(wasm.length).toBe(0);
        expect(errors.some((diagnostic) => /unsupported construct at '%'/.test(diagnostic.message))).toBe(true);
        expect(errors.some((diagnostic) => /build this contract with clang/.test(diagnostic.message))).toBe(true);
    });

    // It must fail even where a fidelity warning would have been tolerated, since the parse is unsound.
    test("fails even with the strict gate disabled", async () => {
        const result = await compileContractWithTypeScript({
            source: withMember("% uint64 v;"),
            contractName: "ParseProbe",
            slot: 28,
            qpiHeader: HEADERS(),
            strict: false,
        });

        expect(result.wasm.length).toBe(0);
        expect(result.diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toBe(true);
    });

    test("a clean contract is untouched", async () => {
        const { wasm, errors } = await compileMember("uint64 plain;");

        expect(errors).toEqual([]);
        expect(wasm.length).toBeGreaterThan(0);
    });

    // These two reached the same backstop until they got handlers. qpi.h uses both -- `typename` for a
    // dependent oracle reply field, `volatile` on m256i's assignment operators -- so they must parse.
    test("a volatile member parses, with the qualifier dropped", async () => {
        const { wasm, errors } = await compileMember("volatile uint64 v;");

        expect(errors).toEqual([]);
        expect(wasm.length).toBeGreaterThan(0);
    });

    test("a typename-qualified dependent member parses", async () => {
        const { wasm, errors } = await compileMember("typename QPI::Array<uint64, 2> pair;");

        expect(errors).toEqual([]);
        expect(wasm.length).toBeGreaterThan(0);
    });
});

// `T local;` runs T's default constructor in C++. Zeroing the slot and skipping the body left every
// field at 0; clang returns 42 for this contract.
describe.skipIf(!HAS_CORE)("a default constructor runs for a struct local", () => {
    const CTOR_SRC = `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Guarded { uint64 mark; Guarded() { mark = 42; } };
  struct StateData { uint64 x; };
  struct Run_input { uint64 seed; };
  struct Run_output {};
  PUBLIC_PROCEDURE(Run) { Guarded g; state.mut().x = g.mark; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};
`;

    test("the constructor body assigns, so the field is not left zero", async () => {
        const result = await compileContractWithTypeScript({
            source: CTOR_SRC,
            contractName: "CtorProbe",
            slot: 27,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 1 << 20,
        });

        expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);
        expect(runProcedureStateWord(result.wasm)).toBe(42n);
    });
});

// qpi.h's `Ch` namespace declares one constant per character, so a struct local named `u` used as a
// value resolved to 'u' (117) instead of being converted or refused.
describe.skipIf(!HAS_CORE)("an aggregate local never resolves to a named constant", () => {
    const classToScalar = (localName: string) => `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct U { uint64 v; operator uint64() const { return v; } };
  struct StateData { uint64 x; };
  struct Run_input { uint64 seed; };
  struct Run_output {};
  PUBLIC_PROCEDURE(Run) { U ${localName}; ${localName}.v = 11; state.mut().x = ${localName}; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};
`;

    const compileLocal = async (localName: string) => {
        const result = await compileContractWithTypeScript({
            source: classToScalar(localName),
            contractName: "ShadowProbe",
            slot: 27,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 1 << 20,
        });
        return {
            wasm: result.wasm,
            errors: result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR),
        };
    };

    // `u` collides with Ch::u; `total` does not. Both must fail the same way.
    for (const localName of ["u", "total"]) {
        test(`a local named '${localName}' is refused, not silently converted`, async () => {
            const { wasm, errors } = await compileLocal(localName);

            expect(wasm.length).toBe(0);
            expect(errors.some((diagnostic) => /unsupported conversion from class type to a scalar for '.+'/.test(diagnostic.message))).toBe(true);
        });
    }

    // The bug produced 'u' == 117 with no diagnostic at all, so pin that it cannot compile to a value.
    test("never compiles to the character constant", async () => {
        const result = await compileContractWithTypeScript({
            source: classToScalar("u"),
            contractName: "ShadowProbe",
            slot: 27,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 1 << 20,
            strict: false,
        });

        expect(result.wasm.length === 0 || runProcedureStateWord(result.wasm) !== 117n).toBe(true);
    });
});
