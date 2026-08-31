// A functional scalar cast may name its target through an alias: `N::W(x)` narrows exactly as the scalar
// the alias chain ends at. The lookup that decides this also decides whether a one-argument call is a cast
// at all, so the negative rows are the point — a real call, a struct alias and a container alias must all
// keep falling through to ordinary call handling rather than being narrowed to a scalar.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const HEADERS = () => loadQpiHeader(CORE_PATH);

const ALIASES = `namespace Narrow {
  typedef uint16 Word;
  typedef Word WordAlias;
  typedef uint8 Byte;
  struct Record { uint8 only; };
  typedef Record RecordAlias;
  typedef Array<uint64, 4> Buffer;
}
namespace Outer { namespace Inner { typedef uint16 Word; } }`;

const contract = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
${ALIASES}
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; Narrow::Buffer buffer; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function compile(body: string) {
    return compileContractWithTypeScript({
        source: contract(body),
        contractName: "AliasCastEdge",
        slot: 27,
        qpiHeader: HEADERS(),
        arenaSizeBytes: 1 << 20,
    });
}

async function evaluate(body: string): Promise<bigint> {
    const result = await compile(body);
    expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, result.wasm!);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

const castTo = (spelling: string, value: string) => evaluate(`state.mut().result = (uint64)${spelling}(${value});`);

describe.skipIf(!HAS_CORE)("edge audit — functional casts through an alias", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("a scalar named directly narrows to its own width", async () => {
        expect(await castTo("uint16", "70000")).toBe(4464n);
        expect(await castTo("uint8", "300")).toBe(44n);
        expect(await castTo("uint64", "70000")).toBe(70000n);
    });

    test("a scalar named through an alias narrows the same way", async () => {
        expect(await castTo("Narrow::Word", "70000")).toBe(4464n);
        expect(await castTo("Narrow::WordAlias", "70000")).toBe(4464n);
        expect(await castTo("Narrow::Byte", "300")).toBe(44n);
        expect(await castTo("Outer::Inner::Word", "70000")).toBe(4464n);
        expect(await evaluate("using namespace Narrow; state.mut().result = (uint64)Word(70000);")).toBe(4464n);
    });

    test("the cast applies to a value, not only a literal", async () => {
        expect(await evaluate("uint64 wide = 70000; state.mut().result = (uint64)Narrow::Word(wide);")).toBe(4464n);
    });

    // Deciding a name is a scalar is what turns a one-argument call into a cast, so anything that is NOT a
    // scalar has to keep reaching ordinary call handling.
    test("a one-argument call that is not a scalar cast still behaves as a call", async () => {
        expect(await evaluate("state.mut().buffer.set(0, 77); state.mut().result = state.get().buffer.get(0);")).toBe(77n);
        expect(await evaluate("state.mut().result = div(100ULL, 7ULL);")).toBe(14n);
    });

    test("an alias of a struct or a container is not narrowed to a scalar", async () => {
        for (const spelling of ["Narrow::RecordAlias", "Narrow::Buffer"]) {
            const result = await compile(`state.mut().result = (uint64)${spelling}(0);`);
            expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR).length).toBeGreaterThan(0);
        }
    });
});
