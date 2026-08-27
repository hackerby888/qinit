import { expect, test } from "bun:test";
import { AbiTypeKind, extractIdl } from "../../src/compile/idl";
import { formatAbiType, layoutOf, parseContractIdl } from "@qinit/proto";

const SOURCE = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Leaf { sint64 value; };
  struct Middle { Leaf leaf; uint32 tag; };
  struct Padded { uint64 value; uint8 flag; };
  struct Deep_input { Padded padded; uint8 tail; };
  struct Deep_output { Array<Middle, 4> items; };
  PUBLIC_FUNCTION(Deep) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Deep, 1);
  }
};`;

const entry = extractIdl(SOURCE, "Nested").functions[0];

test("nested structs retain names, offsets, and trailing alignment", () => {
    const input = entry.input;
    if (input.kind !== AbiTypeKind.STRUCT) {
        throw new Error("Deep_input must be a struct");
    }
    const padded = input.fields[0].type;
    expect(padded.kind).toBe(AbiTypeKind.STRUCT);
    if (padded.kind === AbiTypeKind.STRUCT) {
        expect(padded.fields.map((field) => [field.name, field.offset, field.size])).toEqual([
            ["value", 0, 8],
            ["flag", 8, 1],
        ]);
        expect(padded.size).toBe(16);
    }
    expect(input.fields[1].offset).toBe(16);
    expect(input.size).toBe(24);
    expect(input.format).toBe("{ uint64, uint8 }, uint8");
});

test("arrays of nested structs retain the complete element tree", () => {
    const output = entry.output;
    if (output.kind !== AbiTypeKind.STRUCT) {
        throw new Error("Deep_output must be a struct");
    }
    const items = output.fields[0].type;
    expect(items.kind).toBe(AbiTypeKind.ARRAY);
    if (items.kind !== AbiTypeKind.ARRAY) {
        return;
    }
    expect(items.count).toBe(4);
    expect(items.element.kind).toBe(AbiTypeKind.STRUCT);
    if (items.element.kind !== AbiTypeKind.STRUCT) {
        return;
    }
    expect(items.element.fields.map((field) => field.name)).toEqual(["leaf", "tag"]);
    const leaf = items.element.fields[0].type;
    expect(leaf.kind).toBe(AbiTypeKind.STRUCT);
    if (leaf.kind === AbiTypeKind.STRUCT) {
        expect(leaf.fields.map((field) => [field.name, field.type.format])).toEqual([["value", "sint64"]]);
    }
});

test("multi-variable declarations produce one typed field per name", () => {
    const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Many_input { id a, b, c, d; sint64 x, y; };
  struct Many_output {};
  PUBLIC_PROCEDURE(Many) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Many, 1);
  }
};`;
    const input = extractIdl(source, "Many").procedures[0].input;
    if (input.kind !== AbiTypeKind.STRUCT) {
        throw new Error("Many_input must be a struct");
    }
    expect(input.fields.map((field) => field.name)).toEqual(["a", "b", "c", "d", "x", "y"]);
    expect(input.fields.map((field) => field.type.format)).toEqual(["id", "id", "id", "id", "sint64", "sint64"]);
    expect(input.format).toBe("id, id, id, id, sint64, sint64");
});

// A container inside a container never appeared in these fixtures, yet it is what the state viewer meets
// on real contracts. The sizes below must match what proto computes from the same type tree.
const NESTED_CONTAINERS = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Key { Array<id, 2> owners; uint64 tag; };
  struct Deep { BitArray<64> bits; uint128 total; };
  struct StateData {
    HashMap<Key, LinkedList<uint64, 2>, 2> nestedMap;
    Collection<Deep, 2> deep;
    Array<Array<uint64, 2>, 2> matrix;
    HashSet<Key, 4> keys;
  };
  INITIALIZE() {}
};`;

test("containers nested inside containers keep the layout proto computes for them", () => {
    const idl = extractIdl(NESTED_CONTAINERS, "NestedContainers", { slot: 7 });

    expect(idl.state.size).toBe(984);
    expect(idl.state.align).toBe(8);
    expect(idl.state.fields.map((field) => [field.name, field.offset, field.size, field.type.kind])).toEqual([
        ["nestedMap", 0, 360, AbiTypeKind.HASH_MAP],
        ["deep", 360, 280, AbiTypeKind.COLLECTION],
        ["matrix", 640, 32, AbiTypeKind.ARRAY],
        ["keys", 672, 312, AbiTypeKind.HASH_SET],
    ]);

    expect(formatAbiType(idl.state.fields[0].type)).toBe(
        "{ [2;{ { [2;id], uint64 }, { [2;{ uint64, sint64, sint64 }], [1;uint64], sint64, sint64, sint64, uint64, uint64 } }], [1;uint64], uint64, uint64 }",
    );
    expect(formatAbiType(idl.state.fields[2].type)).toBe("[2;[2;uint64]]");

    // The frontend, the validator, and the format-string parser must all agree on the same bytes.
    expect(parseContractIdl(idl).state.size).toBe(984);
    for (const field of idl.state.fields) {
        expect(`${field.name}: ${JSON.stringify(layoutOf(formatAbiType(field.type)))}`).toBe(
            `${field.name}: ${JSON.stringify({ size: field.size, align: field.type.align })}`,
        );
    }
});
