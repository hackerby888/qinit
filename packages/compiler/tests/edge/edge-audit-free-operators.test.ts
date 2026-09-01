// An operator a type does not declare as a member is still resolvable: C++ finds a non-member candidate,
// which is the only way to give a comparison to a type you do not own (QPI::Asset is a bare aggregate, so
// Nostromo declares `operator==` for it at namespace scope). Both non-member spellings are covered here —
// namespace scope and `friend` — because they differ only in where they are written.
//
// Every row runs the contract rather than only compiling it. `operator==` is declared many times over at
// global scope (m256i alone contributes four), and picking the wrong candidate still compiles: it answers
// a two-word struct with the 32-byte comparison and is simply always false.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const HEADERS = () => loadQpiHeader(CORE_PATH);

const contract = (declarations: string, body: string) => `using namespace QPI;
${declarations}
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function compile(declarations: string, body: string) {
    return compileContractWithTypeScript({
        source: contract(declarations, body),
        contractName: "FreeOperatorEdge",
        slot: 27,
        qpiHeader: HEADERS(),
        arenaSizeBytes: 1 << 20,
    });
}

// Reads state.result back out of the running contract, so the value is the one the emitted call produced.
async function evaluate(declarations: string, body: string): Promise<bigint> {
    const result = await compile(declarations, body);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, result.wasm!);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

const PAIR = "struct Pair { uint64 a; };";
const FREE = `${PAIR}
inline bool operator==(const Pair& l, const Pair& r) { return l.a == r.a; }`;
const FRIEND = `struct Pair { uint64 a;
  friend bool operator==(const Pair& l, const Pair& r) { return l.a == r.a; } };`;
// A member and a non-member for the same operands; C++ prefers neither by spelling, but a member is what
// this backend resolved before non-members existed, so the row pins that it still wins.
const MEMBER_AND_FREE = `struct Pair { uint64 a;
  bool operator==(const Pair& o) const { return true; } };
inline bool operator==(const Pair& l, const Pair& r) { return false; }`;
// 32 bytes wide, the size the byte-wise m256i comparison stands in for.
const WIDE = `struct Wide { uint64 a; uint64 b; uint64 c; uint64 d; };
inline bool operator==(const Wide& l, const Wide& r) { return l.a == r.a; }`;

const same = "Pair x; x.a = 5; Pair y; y.a = 5; ";
const differ = "Pair x; x.a = 5; Pair y; y.a = 6; ";

describe.skipIf(!HAS_CORE)("edge audit — non-member operators", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("a namespace-scope operator== decides the comparison", async () => {
        expect(await evaluate(FREE, same + "state.mut().result = (x == y) ? 1 : 0;")).toBe(1n);
        expect(await evaluate(FREE, differ + "state.mut().result = (x == y) ? 1 : 0;")).toBe(0n);
    });

    test("a friend operator== decides it the same way", async () => {
        expect(await evaluate(FRIEND, same + "state.mut().result = (x == y) ? 1 : 0;")).toBe(1n);
        expect(await evaluate(FRIEND, differ + "state.mut().result = (x == y) ? 1 : 0;")).toBe(0n);
    });

    test("!= is rewritten from a non-member ==", async () => {
        expect(await evaluate(FREE, differ + "state.mut().result = (x != y) ? 1 : 0;")).toBe(1n);
        expect(await evaluate(FREE, same + "state.mut().result = (x != y) ? 1 : 0;")).toBe(0n);
    });

    test("the result reads the same in every expression position", async () => {
        expect(await evaluate(FREE, same + "state.mut().result = (x == y);")).toBe(1n);
        expect(await evaluate(FREE, same + "if (x == y) { state.mut().result = 1; }")).toBe(1n);
        expect(await evaluate(FREE, same + "uint64 t = (x == y); state.mut().result = t;")).toBe(1n);
    });

    test("a member candidate still wins over a non-member one", async () => {
        expect(await evaluate(MEMBER_AND_FREE, differ + "state.mut().result = (x == y) ? 1 : 0;")).toBe(1n);
    });

    // The 32-byte byte-wise comparison stands in for m256i's operators. A struct that declares its own
    // must get that one, or a wide type silently compares by bytes it never asked to compare.
    test("a declared operator wins over the byte-wise substitution at 32 bytes", async () => {
        const body = "Wide x; x.a = 5; x.b = 1; Wide y; y.a = 5; y.b = 2; state.mut().result = (x == y) ? 1 : 0;";
        expect(await evaluate(WIDE, body)).toBe(1n);
    });

    test("id keeps comparing by bytes, with no non-member candidate claiming it", async () => {
        expect(await evaluate("", "id a = NULL_ID; id b = NULL_ID; state.mut().result = (a == b) ? 1 : 0;")).toBe(1n);
        expect(await evaluate("", "id a = NULL_ID; id b = id(1, 0, 0, 0); state.mut().result = (a == b) ? 1 : 0;")).toBe(0n);
    });

    test("a type with no candidate at all is still reported", async () => {
        const result = await compile(PAIR, same + "state.mut().result = (x == y) ? 1 : 0;");
        const messages = result.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR).map((diagnostic) => diagnostic.message);
        expect(messages.join(" ")).toContain("no viable operator== for 'Pair'");
    });
});
