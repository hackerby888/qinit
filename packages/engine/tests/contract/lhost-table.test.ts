// the simulator's host table against the generated ABI rows: a name or parameter-count mismatch links on neither runtime, or links and misreads its arguments.
import { expect, test } from "bun:test";
import { WASM_ABI_METADATA } from "@qinit/core/wasm/generated/wasm-abi";
import { Contract } from "../../src/contract/runtime";

type LhostBuilder = { buildLhost(u8: () => Uint8Array, contextView: () => unknown): Record<string, Function> };

// the builders only close over the instance, so a bare prototype object is enough to build the table.
const table = (Object.create(Contract.prototype) as LhostBuilder).buildLhost(
    () => new Uint8Array(0),
    () => null,
);

test("the host table holds exactly the generated import names", () => {
    expect(Object.keys(table).sort()).toEqual(WASM_ABI_METADATA.lhost.map((row) => row.name).sort());
});

test("every host function declares its row's parameter count", () => {
    const wrongArity = WASM_ABI_METADATA.lhost.filter((row) => table[row.name]?.length !== row.params.length).map((row) => row.name);

    expect(wrongArity).toEqual([]);
});
