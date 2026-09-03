// The IDL must describe exactly the bytes each printed argument ships, for every shape a contract can
// hand CC_PRINT. The reader decodes by that type and shows a mismatch raw, so a wrong type here is a
// print a dev cannot read.
import { expect, test } from "bun:test";
import { AbiTypeKind, type ContractCheat } from "@qinit/proto/contract-idl";
import { compileContractWithTypeScript } from "@qinit/compiler/browser";
import { loadWasmFixtureIdl } from "../../../../test-utils/wasm-fixtures";

function valueParts(cheats: readonly ContractCheat[]): [string, string, number][] {
    return cheats.flatMap((cheat) =>
        cheat.parts.filter((part) => part.type).map((part): [string, string, number] => [part.expr ?? "", part.type!.format, part.type!.size]),
    );
}

test("every printed argument carries its declared type", async () => {
    const idl = await loadWasmFixtureIdl("CheatShapes");

    expect(valueParts(idl.cheats)).toEqual([
        ["output.value", "uint64", 8],
        ["output.value + 2", "uint64", 8],
        ["input", "", 1],
        ["output", "{ uint64 }", 8],
        [
            "state.get()",
            "{ uint64, [4;uint64], [2;{ uint64, uint16 }], id, { [4;{ id, uint64 }], [1;uint64], uint64, uint64 }, { uint64, { [4;{ uint64, uint64 }], [1;uint64], uint64, uint64 } } }",
            384,
        ],
        ["input.abc", "{ uint64, uint16 }", 16],
        ["input.abc.b", "uint16", 2],
        ["input.neg", "sint32", 4],
        ["input.flag", "bit", 1],
        ["state.get().nums", "[4;uint64]", 32],
        ["state.get().nums.get(1)", "uint64", 8],
        ["state.get().items.get(0)", "{ uint64, uint16 }", 16],
        ["state.get().owner", "id", 32],
        ["qpi.invocator()", "id", 32],
        ["state.get().balances", "{ [4;{ id, uint64 }], [1;uint64], uint64, uint64 }", 184],
        ["input.neg + 1", "uint64", 8],
    ]);
});

test("a bare root keeps its struct's name", async () => {
    const idl = await loadWasmFixtureIdl("CheatShapes");
    const named = idl.cheats.flatMap((cheat) => cheat.parts).filter((part) => part.expr === "input" || part.expr === "output");

    expect(named.map((part) => (part.type?.kind === AbiTypeKind.STRUCT ? part.type.name : undefined))).toEqual(["Get_input", "Get_output"]);
});

test("a literal occupies an ordinal but carries no type, and an all-literal print has no value part", async () => {
    const idl = await loadWasmFixtureIdl("CheatShapes");
    const mixed = idl.cheats.find((cheat) => cheat.parts.some((part) => part.lit === "after adding 2"))!;
    const marker = idl.cheats.find((cheat) => cheat.parts.some((part) => part.lit === "flag set"))!;

    expect(mixed.parts.map((part) => (part.lit !== undefined ? "lit" : "value"))).toEqual(["lit", "value", "lit"]);
    expect(marker.parts).toEqual([{ lit: "flag set" }]);
});

// Every container accessor, printed. A by-reference or by-value element ships its bytes and must be
// typed as that element; a scalar the accessor returns rides the register and keeps its declared
// width and sign, so a priority reads negative, a bit reads as one and a bool as the byte it is.
test("a container accessor prints as what it hands back", async () => {
    const source = `using namespace QPI;
struct Acc2 {};
struct Acc : public ContractBase {
    struct Order { id entity; sint64 amount; };
    struct StateData {
        Array<uint64, 4> nums; BitArray<64> bits; HashMap<uint64, Order, 4> map; HashSet<uint16, 4> set;
        Collection<Order, 4> orders; LinkedList<Order, 4> list;
    };
    struct Get_input { sint64 i; };
    struct Get_output { uint64 v; };
    PUBLIC_FUNCTION(Get) {
        CC_PRINT(state.get().nums.get(input.i), state.get().bits.get(input.i), state.get().map.key(input.i), state.get().map.value(input.i));
        CC_PRINT(state.get().set.key(input.i), state.get().orders.element(input.i), state.get().orders.priority(input.i), state.get().orders.pov(input.i));
        CC_PRINT(state.get().list.element(input.i), state.get().orders.population(), state.get().map.get(input.i, output.v));
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;
    const compiled = await compileContractWithTypeScript({ source, contractName: "Acc", slot: 28, arenaSizeBytes: 1024 * 1024 });

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(valueParts(compiled.idl!.cheats)).toEqual([
        ["state.get().nums.get(input.i)", "uint64", 8],
        ["state.get().bits.get(input.i)", "bit", 1],
        ["state.get().map.key(input.i)", "uint64", 8],
        ["state.get().map.value(input.i)", "{ id, sint64 }", 40],
        ["state.get().set.key(input.i)", "uint16", 2],
        ["state.get().orders.element(input.i)", "{ id, sint64 }", 40],
        ["state.get().orders.priority(input.i)", "sint64", 8],
        ["state.get().orders.pov(input.i)", "id", 32],
        ["state.get().list.element(input.i)", "{ id, sint64 }", 40],
        ["state.get().orders.population()", "uint64", 8],
        ["state.get().map.get(input.i, output.v)", "uint8", 1],
    ]);
});
