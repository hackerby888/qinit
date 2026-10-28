// A packed asset name is a uint64 on the wire; a field named for it reads as the letters a dev typed, including a mistyped one, in call views and state diffs alike.
import { expect, test } from "bun:test";
import { extractIdl } from "@qinit/build";
import { packAssetName } from "@qinit/proto";
import { AbiScalarKind, AbiTypeKind, type AbiType } from "@qinit/proto/contract-idl";
import { abiValueText, stateFieldsOf } from "../../src/trace/state-format";
import { stateDiffLines } from "../../src/trace/state-diff";

const uint64: AbiType = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.UINT64, size: 8, align: 8, format: "uint64" } as AbiType;
const struct = (...names: string[]): AbiType =>
    ({ kind: AbiTypeKind.STRUCT, name: "In", fields: names.map((name, index) => ({ name, offset: index * 8, size: 8, type: uint64 })), size: names.length * 8, align: 8, format: "" }) as AbiType;

test("an assetName field reads as its letters, a same-valued amount stays a number", () => {
    expect(abiValueText([packAssetName("MYTW"), 1000n], struct("assetName", "numberOfShares"))).toBe("{assetName: MYTW, numberOfShares: 1000}");
    expect(abiValueText([packAssetName("MYTW")], struct("amount"))).toBe(`{amount: ${packAssetName("MYTW")}}`);
});

test("a mistyped pack shows the odd name it spells, zero stays zero", () => {
    expect(abiValueText([1480415565n, 0n], struct("assetName", "issuerAssetName"))).toBe("{assetName: MY=X, issuerAssetName: 0}");
});

test("a state diff row on an assetName field shows the letters", async () => {
    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 assetName; uint64 count; };
  INITIALIZE() {}
};`;
    const fields = stateFieldsOf(extractIdl(source, "Names", { slot: 7 }));
    const after = new Uint8Array(16);
    let packed = packAssetName("MYTW");
    for (let index = 0; index < 8; index++) {
        after[index] = Number(packed & 0xffn);
        packed >>= 8n;
    }
    const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    const rows = await stateDiffLines(fields, [{ off: 0, before: hex(new Uint8Array(8)), after: hex(after.slice(0, 8)) }]);

    expect(rows.map((row) => `${row.label} ${row.text}`)).toEqual(["assetName 0 → MYTW"]);
});
