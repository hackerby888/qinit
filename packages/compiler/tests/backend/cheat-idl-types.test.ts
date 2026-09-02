// The IDL must describe exactly the bytes each printed argument ships, for every shape a contract can
// hand CC_PRINT. The reader decodes by that type and shows a mismatch raw, so a wrong type here is a
// print a dev cannot read.
import { expect, test } from "bun:test";
import { AbiTypeKind, type ContractCheat } from "@qinit/proto/contract-idl";
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
        ["state.get()", "{ uint64, [4;uint64], [2;{ uint64, uint16 }], id, { [4;{ id, uint64 }], [1;uint64], uint64, uint64 } }", 288],
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
