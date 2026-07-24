import { expect, test } from "bun:test";
import { AbiTypeKind, extractIdl } from "../../src/idl";

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
    expect(leaf.fields.map((field) => [field.name, field.type.format])).toEqual([
      ["value", "sint64"],
    ]);
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
  expect(input.fields.map((field) => field.type.format)).toEqual([
    "id",
    "id",
    "id",
    "id",
    "sint64",
    "sint64",
  ]);
  expect(input.format).toBe("id, id, id, id, sint64, sint64");
});
