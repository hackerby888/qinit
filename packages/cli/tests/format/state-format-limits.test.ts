// The rendering limits themselves: where the item cap falls, how a single skipped bit reads, and what
// happens to the shapes that carry no name — the cases the container tests step over on their way to a value.
import { test, expect } from "bun:test";
import { extractIdl } from "@qinit/build";
import { AbiTypeKind, type AbiStruct, type AbiType } from "@qinit/proto/contract-idl";
import { fmtVal, formatStateValue, jstr } from "../../src/trace/state-format";

const MAX_ITEMS = 32;
const SRC = `using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Empty {};
  struct StateData {
    Array<uint32, 32> exact;
    SlowAnySizeArray<uint32, 33> over;
    BitArray<8> bits;
    Empty empty;
  };
  INITIALIZE() {}
};`;

const STATE = extractIdl(SRC, "Limits", { slot: 9 }).state;
const typeOf = (name: string): AbiType => STATE.fields.find((field) => field.name === name)!.type;
const distinct = (count: number) => Array.from({ length: count }, (_, index) => index);

test("the item cap keeps a full block at exactly 32 and truncates at 33", () => {
    expect(formatStateValue(distinct(MAX_ITEMS), typeOf("exact"), false)).toBe(`[${distinct(MAX_ITEMS).join(", ")}]`);
    expect(formatStateValue(distinct(MAX_ITEMS + 1), typeOf("over"), false)).toBe(`[${distinct(MAX_ITEMS).join(", ")}, … +1 more (--all)]`);
    expect(formatStateValue(distinct(MAX_ITEMS + 1), typeOf("over"), true)).toBe(`[${distinct(MAX_ITEMS + 1).join(", ")}]`);
});

test("an untyped array reports how many items the cap hid, counting from the same 32", () => {
    expect(fmtVal(distinct(MAX_ITEMS))).toBe(`[${distinct(MAX_ITEMS).join(", ")}]`);
    expect(fmtVal(distinct(MAX_ITEMS + 5))).toBe(`[${distinct(MAX_ITEMS).join(", ")}, … +5 more (--all)]`);
    expect(fmtVal(distinct(MAX_ITEMS + 5), true)).toBe(`[${distinct(MAX_ITEMS + 5).join(", ")}]`);
});

test("one skipped bit reads as a single index, a run reads as a range with its count", () => {
    const bits = typeOf("bits");

    expect(formatStateValue([0, 1, 0, 0, 0, 0, 0, 0], bits, false)).toBe("[0]=0 (skipped), [1]=1, [2..7]=0 ×6 (skipped)");
    expect(formatStateValue([1, 1, 1, 1, 1, 1, 1, 1], bits, false)).toBe("[0]=1, [1]=1, [2]=1, [3]=1, [4]=1, [5]=1, [6]=1, [7]=1");
    expect(formatStateValue([], bits, false)).toBe("[0..7]=0 ×8 (skipped)");
});

test("a struct with no fields is {} and an unnamed field falls back to its position", () => {
    const anonymous: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 16,
        align: 8,
        format: "",
        fields: [
            { name: "", offset: 0, size: 8, type: { kind: AbiTypeKind.SCALAR, scalar: "uint64", size: 8, align: 8, format: "uint64" } as AbiType },
            { name: "named", offset: 8, size: 4, type: { kind: AbiTypeKind.SCALAR, scalar: "uint32", size: 4, align: 4, format: "uint32" } as AbiType },
        ],
    };

    expect(formatStateValue([], typeOf("empty"), false)).toBe("{}");
    expect(formatStateValue([1n, 2], anonymous, false)).toBe("{0: 1, named: 2}");
});

test("a bigint survives the JSON rendering that would otherwise throw on it", () => {
    expect(jstr({ amount: 2n ** 70n, name: "x" })).toBe('{"amount":"1180591620717411303424","name":"x"}');
    expect(jstr([1n, [2n]])).toBe('["1",["2"]]');
    expect(fmtVal({ nested: { amount: 5n } })).toBe('{"nested":{"amount":"5"}}');
});
