import { DiagnosticSeverity } from "../../src/shared/enums";
import { QPI_SNAPSHOT } from "../../src/generated/qpi-snapshot";
// qpi.h's `Ch` namespace declares a constant per character (`a = 'a'`, `T = 'T'`, `_0 = '0'`, ...), so
// any short identifier collides with one. A nearer binding must always win.
import { describe, expect, test } from "bun:test";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript } from "../../src/index";

// The pinned snapshot keeps this hermetic: name resolution does not need a live core checkout.
await initK12();

function runStateWord(wasm: Uint8Array): bigint {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, wasm);
    sim.procedure(27, 1, new Uint8Array(32), { invocator: user });
    const state = new Uint8Array(sim.contracts.get(27)!.state());
    return new DataView(state.buffer, state.byteOffset).getBigUint64(0, true);
}

const contract = (members: string, body: string, prelude = "") => `
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};
${prelude}

struct CONTRACT_STATE_TYPE : public ContractBase {
  ${members}
  struct StateData { uint64 x; };
  struct Run_input { uint64 seed; };
  struct Run_output {};
  PUBLIC_PROCEDURE(Run) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};
`;

async function evaluate(members: string, body: string, prelude = ""): Promise<{ value: bigint | null; errors: string[] }> {
    const result = await compileContractWithTypeScript({
        source: contract(members, body, prelude),
        contractName: "ShadowProbe",
        slot: 27,
        qpiHeader: QPI_SNAPSHOT,
        arenaSizeBytes: 1 << 20,
    });
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message);
    return { value: errors.length > 0 ? null : runStateWord(result.wasm), errors };
}

describe("a template parameter hides a namespace-scope constant", () => {
    // The original defect: sizeof inside a template method resolved `T` to Ch::T, whose underlying
    // type is `char`, and reported that width instead of the bound type's size. It collapsed K12's
    // digest length from 512 to 1 and silently broke every reveal in the RANDOM contract.
    const WIDE = "struct Wide { uint64 parts[8]; };";

    test("sizeof(T) inside a template method is the bound type's size", async () => {
        const { value, errors } = await evaluate(
            `${WIDE} template <typename T> struct Sizer { uint64 measure(const T& v) const { return sizeof(T); } };`,
            "Sizer<Wide> s; Wide w; state.mut().x = s.measure(w);",
        );

        expect(errors).toEqual([]);
        expect(value).toBe(64n);
    });

    test("sizeof(value) inside a template method is the bound type's size", async () => {
        const { value, errors } = await evaluate(
            `${WIDE} template <typename T> struct Sizer { uint64 measure(const T& v) const { return sizeof(v); } };`,
            "Sizer<Wide> s; Wide w; state.mut().x = s.measure(w);",
        );

        expect(errors).toEqual([]);
        expect(value).toBe(64n);
    });

    // A namespace-scope constant of a sized type reproduces the defect without depending on `char`
    // having a width, so this case bites today rather than waiting for the char entry to land.
    test("a sized namespace constant does not hide a template parameter", async () => {
        const { value, errors } = await evaluate(
            `${WIDE} template <typename T> struct Sizer { uint64 measure(const T& v) const { return sizeof(T); } };`,
            "Sizer<Wide> s; Wide w; state.mut().x = s.measure(w);",
            "static constexpr uint8 T = 9;",
        );

        expect(errors).toEqual([]);
        expect(value).toBe(64n);
    });

    // Every single letter is a Ch constant, so the defect was never specific to `T`.
    for (const parameter of ["T", "U", "A", "i"]) {
        test(`a parameter named '${parameter}' still measures its bound type`, async () => {
            const { value, errors } = await evaluate(
                `${WIDE} template <typename ${parameter}> struct Sizer { uint64 measure(const ${parameter}& v) const { return sizeof(${parameter}); } };`,
                `Sizer<Wide> s; Wide w; state.mut().x = s.measure(w);`,
            );

            expect(errors).toEqual([]);
            expect(value).toBe(64n);
        });
    }
});

describe("a local hides a namespace-scope constant", () => {
    // Ch::a is 97, Ch::i is 105, Ch::u is 117, Ch::_0 is 48 — a local resolving to one of those
    // would read as that character code rather than its assigned value.
    for (const [name, code] of [
        ["a", 97n],
        ["i", 105n],
        ["u", 117n],
        ["_0", 48n],
        ["Z", 90n],
    ] as const) {
        test(`a scalar local named '${name}' is not the character constant ${code}`, async () => {
            const { value, errors } = await evaluate("", `uint64 ${name} = 7; state.mut().x = ${name};`);

            expect(errors).toEqual([]);
            expect(value).toBe(7n);
            expect(value).not.toBe(code);
        });
    }

    test("a loop counter named 'i' counts rather than reading as 'i'", async () => {
        const { value, errors } = await evaluate("", "uint64 total = 0; for (uint64 i = 0; i < 4; i++) { total += i; } state.mut().x = total;");

        expect(errors).toEqual([]);
        expect(value).toBe(6n);
    });

    test("a struct field reached through a local named 'e' reads the field", async () => {
        const { value, errors } = await evaluate("struct Box { uint64 v; };", "Box e; e.v = 11; state.mut().x = e.v;");

        expect(errors).toEqual([]);
        expect(value).toBe(11n);
    });
});
