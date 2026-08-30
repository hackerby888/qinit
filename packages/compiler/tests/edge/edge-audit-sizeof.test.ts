// `sizeof(X)` only parses as a type when X starts with a type keyword; every other spelling arrives as an
// expression, where an unplaceable name used to answer with a default width. The table covers the whole
// family — keyword, alias, struct, enum, container, qualified or not — because fixing one spelling here
// moves the shared ordering that decides all of them, and the lvalue rows are what catch that.
import { DiagnosticSeverity } from "../../src/shared/enums";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { QubicSimulator } from "@qinit/engine";
import { compileContractWithTypeScript, loadQpiHeader } from "../../src/index";

const HEADERS = () => loadQpiHeader(CORE_PATH);

const contract = (body: string) => `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
typedef uint64 GlobalAlias;
struct GlobalRecord { uint64 first; uint64 second; };
enum class GlobalChoice : uint16 { Only };
namespace Narrow { typedef uint8 Width; struct Record { uint8 only; }; enum class Choice : uint8 { Only }; }
namespace Wide { typedef uint64 Width; struct Record { uint64 first; uint64 second; }; enum class Choice : uint16 { Only }; typedef Array<uint64, 4> Buffer; }
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 result; };
  struct Nested { uint64 first; uint64 second; };
  struct Go_input {}; struct Go_output {};
  PUBLIC_PROCEDURE(Go) { ${body} }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};`;

async function measure(body: string): Promise<bigint> {
    const result = await compileContractWithTypeScript({
        source: contract(body),
        contractName: "SizeofEdge",
        slot: 27,
        qpiHeader: HEADERS(),
        arenaSizeBytes: 1 << 20,
    });
    expect(result.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR)).toHaveLength(0);

    const simulator = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    const user = new Uint8Array(32).fill(7);
    simulator.fund(user, 1_000_000n);
    simulator.deploy(27, result.wasm!);
    simulator.procedure(27, 1, undefined, { invocator: user });
    const state = simulator.contracts.get(27)!.state();
    return new DataView(state.buffer, state.byteOffset, state.byteLength).getBigUint64(0, true);
}

const sizeOf = (spelling: string) => measure(`state.mut().result = sizeof(${spelling});`);

describe.skipIf(!HAS_CORE)("edge audit — sizeof spellings", () => {
    beforeAll(async () => {
        await initK12();
    });

    test("a type keyword, a global alias, struct and enum all report their own width", async () => {
        expect(await sizeOf("uint64")).toBe(8n);
        expect(await sizeOf("uint8")).toBe(1n);
        expect(await sizeOf("id")).toBe(32n);
        expect(await sizeOf("GlobalAlias")).toBe(8n);
        expect(await sizeOf("GlobalRecord")).toBe(16n);
        expect(await sizeOf("GlobalChoice")).toBe(2n);
        expect(await sizeOf("Nested")).toBe(16n);
    });

    test("a namespace-qualified type reports its own namespace's width", async () => {
        expect(await sizeOf("Wide::Width")).toBe(8n);
        expect(await sizeOf("Narrow::Width")).toBe(1n);
        expect(await sizeOf("Wide::Record")).toBe(16n);
        expect(await sizeOf("Narrow::Record")).toBe(1n);
        expect(await sizeOf("Wide::Choice")).toBe(2n);
        expect(await sizeOf("Narrow::Choice")).toBe(1n);
        expect(await sizeOf("Wide::Buffer")).toBe(32n);
    });

    // The name-is-a-type lookup runs before the scalar fallback, so a name that is NOT a type has to keep
    // reaching that fallback — sizeOfType answers with a default for anything it cannot place.
    test("a value keeps reporting its own width, not a type's", async () => {
        expect(await measure("uint64 v = 1; state.mut().result = sizeof(v);")).toBe(8n);
        expect(await measure("uint8 v = 1; state.mut().result = sizeof(v);")).toBe(1n);
        expect(await measure("Nested n; state.mut().result = sizeof(n);")).toBe(16n);
        expect(await measure("state.mut().result = sizeof(state.get().result);")).toBe(8n);
    });
});
