// `sizeof(X)` parses as a type only when X starts with a type keyword; every other spelling arrives as an expression, where an unplaceable name defaulted.
import { HAS_CORE } from "../../../../test-utils/paths";
import { beforeAll, describe, expect, test } from "bun:test";
import { initK12 } from "@qinit/core";
import { edgeRunner } from "../support/edge-compile";

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

const run = edgeRunner("SizeofEdge");
const measure = (body: string) => run(contract(body));

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

    // The name-is-a-type lookup runs before the scalar fallback, so a name that is NOT a type must keep reaching it — sizeOfType defaults for the unplaceable.
    test("a value keeps reporting its own width, not a type's", async () => {
        expect(await measure("uint64 v = 1; state.mut().result = sizeof(v);")).toBe(8n);
        expect(await measure("uint8 v = 1; state.mut().result = sizeof(v);")).toBe(1n);
        expect(await measure("Nested n; state.mut().result = sizeof(n);")).toBe(16n);
        expect(await measure("state.mut().result = sizeof(state.get().result);")).toBe(8n);
    });
});
