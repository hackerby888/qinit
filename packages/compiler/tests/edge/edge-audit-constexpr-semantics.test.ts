import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
// Named constexpr expressions retain their declared C++ width/signedness; user contract members also shadow same-named constants imported from qpi.h.
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const HEADERS = () => loadQpiHeader(CORE_PATH);

const wrap = (constant: string, body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  ${constant}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function run(source: string): Promise<bigint> {
    const result = await compileContractWithTypeScript({
        source,
        contractName: "ConstexprEdge",
        slot: 27,
        qpiHeader: HEADERS(),
        arenaSizeBytes: 1 << 20,
    });
    expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    sim.fund(user, 1_000_000n);
    sim.deploy(27, result.wasm);
    sim.procedure(27, 1, undefined, { invocator: user });
    const state = sim.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

describe.skipIf(!HAS_CORE)("edge audit — typed constexpr semantics", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("uint32 constexpr arithmetic wraps at 32 bits", async () => {
        const source = wrap(`static constexpr uint32 EDGE_WRAP_K = 4294967295u;`, `state.mut().result = EDGE_WRAP_K + 1u;`);
        expect(await run(source)).toBe(0n);
    });

    test("constexpr narrowing cast is applied", async () => {
        const source = wrap(`static constexpr uint8 EDGE_NARROW_K = (uint8)300;`, `state.mut().result = EDGE_NARROW_K;`);
        expect(await run(source)).toBe(44n);
    });

    test("uint64 constexpr comparison uses unsigned ordering", async () => {
        const source = wrap(`static constexpr uint64 EDGE_HIGH_K = 0x8000000000000000ull;`, `state.mut().result = EDGE_HIGH_K > 1 ? 1 : 0;`);
        expect(await run(source)).toBe(1n);
    });

    test("contract member constant shadows same-named qpi.h constant", async () => {
        // qpi.h currently contributes an unrelated K; class scope must still resolve this member first.
        const source = wrap(`static constexpr uint64 K = 123;`, `state.mut().result = K;`);
        expect(await run(source)).toBe(123n);
    });

    // The shadow is scoped to the contract: QPI::Ch spells the letters, and a member named after one of
    // them must not change what Ch::K means anywhere else in the same contract.
    test("shadowing a qpi.h constant leaves its qualified name alone", async () => {
        const shadowed = `static constexpr uint64 K = 123;`;
        expect(await run(wrap(shadowed, `state.mut().result = Ch::K;`))).toBe(75n);
        expect(await run(wrap(shadowed, `state.mut().result = QPI::Ch::K;`))).toBe(75n);
        expect(await run(wrap(shadowed, `state.mut().result = Ch::a;`))).toBe(97n);
    });

    test("a partly-qualified constant resolves through the visible using-directive", async () => {
        const unrelated = `static constexpr uint64 Z = 1;`;
        expect(await run(wrap(unrelated, `state.mut().result = Ch::K;`))).toBe(75n);
        expect(await run(wrap(unrelated, `state.mut().result = Ch::_9;`))).toBe(57n);
    });
});

// qpi.h reads its own namespace constants unqualified — NULL_INDEX alone appears 151 times as the
// container "not found" sentinel. A contract constant sharing the name must not rebind any of them.
describe.skipIf(!HAS_CORE)("edge audit — a contract constant cannot rebind qpi.h's own", () => {
    const withMap = (constant: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; HashMap<uint64, uint64, 8> m; };
  ${constant}
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { state.mut().m.set(11, 111); uint64 out = 0; state.mut().result = state.get().m.get(99, out) ? 1 : 0; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

    const compile = async (source: string) => {
        const result = await compileContractWithTypeScript({
            source,
            contractName: "ShadowEdge",
            slot: 27,
            qpiHeader: HEADERS(),
            arenaSizeBytes: 1 << 20,
        });
        expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);
        return result.wasm!;
    };

    test("an unused shadowing constant leaves the emitted module byte-identical", async () => {
        const plain = await compile(withMap(""));
        const shadowed = await compile(withMap(`static constexpr sint64 NULL_INDEX = 999;`));
        expect(shadowed).toEqual(plain);
    });

    test("the contract still reads its own value for that name", async () => {
        const source = wrap(`static constexpr sint64 NULL_INDEX = 999;`, `state.mut().result = NULL_INDEX;`);
        expect(await run(source)).toBe(999n);
    });

    test("a HashMap miss stays a miss while the name is shadowed", async () => {
        expect(await run(withMap(`static constexpr sint64 NULL_INDEX = 999;`))).toBe(0n);
    });
});
