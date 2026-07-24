import { expect, test } from "bun:test";
import {
  AbiScalarKind,
  AbiTypeKind,
  QINIT_IDL_VERSION,
  extractIdl,
} from "../../src/idl";

const SOURCE = `
using namespace QPI;
enum Status { Idle, Running = 5, Stopped };
enum class Color : uint8 { Red, Green, Blue };
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 counter;
    Array<uint32, 2 + 1> nums;
    HashMap<id, uint64, 1024> balances;
  };
  struct LogMsg {
    uint32 _contractIndex;
    uint32 _type;
    uint64 amount;
    sint8 _terminator;
  };
  struct Get_input {};
  struct Get_output { uint64 value; };
  struct Set_input { uint64 value; id owner; };
  struct Set_output {};
  PUBLIC_FUNCTION(Get) {}
  PUBLIC_PROCEDURE(Set) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Get, 1);
    REGISTER_USER_PROCEDURE(Set, 2);
  }
  INITIALIZE() {}
};`;

const idl = extractIdl(SOURCE, "Test", { slot: 28 });

test("extractIdl returns the compiler-owned v2 contract schema", () => {
  expect(idl.version).toBe(QINIT_IDL_VERSION);
  expect(idl.name).toBe("Test");
  expect(idl.slot).toBe(28);
  expect(idl.functions.map((entry) => [entry.inputType, entry.name])).toEqual([[1, "Get"]]);
  expect(idl.procedures.map((entry) => [entry.inputType, entry.name])).toEqual([[2, "Set"]]);
  expect(idl.dependencies).toEqual([]);
});

test("entry structs retain exact formats, fields, offsets, and sizes", () => {
  const get = idl.functions[0];
  expect(get.input.format).toBe("");
  expect(get.output.format).toBe("uint64");
  expect(get.outSize).toBe(get.output.size);
  if (get.output.kind !== AbiTypeKind.STRUCT) {
    throw new Error("Get_output must be a struct");
  }
  expect(get.output.fields.map((field) => [field.name, field.offset, field.size])).toEqual([
    ["value", 0, 8],
  ]);

  const set = idl.procedures[0];
  expect(set.input.format).toBe("uint64, id");
  if (set.input.kind !== AbiTypeKind.STRUCT) {
    throw new Error("Set_input must be a struct");
  }
  expect(set.input.fields.map((field) => [field.name, field.offset, field.type.format])).toEqual([
    ["value", 0, "uint64"],
    ["owner", 8, "id"],
  ]);
  expect(set.output.size).toBe(0);
});

test("state uses typed array and container nodes", () => {
  expect(idl.state.fields.map((field) => field.name)).toEqual([
    "counter",
    "nums",
    "balances",
  ]);

  const numbers = idl.state.fields[1].type;
  expect(numbers.kind).toBe(AbiTypeKind.ARRAY);
  if (numbers.kind === AbiTypeKind.ARRAY) {
    expect(numbers.count).toBe(3);
    expect(numbers.element.format).toBe(AbiScalarKind.UINT32);
  }

  const balances = idl.state.fields[2].type;
  expect(balances.kind).toBe(AbiTypeKind.HASH_MAP);
  if (balances.kind === AbiTypeKind.HASH_MAP) {
    expect(balances.capacity).toBe(1024);
    expect(balances.key.format).toBe("id");
    expect(balances.value.format).toBe("uint64");
    expect(balances.size).toBe(41232);
  }
});

test("enums, logs, and system procedure mask come from semantic analysis", () => {
  expect(idl.enums.find((entry) => entry.name === "Status")?.members).toEqual({
    "0": "Idle",
    "5": "Running",
    "6": "Stopped",
  });
  expect(idl.enums.find((entry) => entry.name === "Color")?.underlying).toBe(
    AbiScalarKind.UINT8,
  );
  expect(idl.logs).toHaveLength(1);
  expect(idl.logs[0].type.format).toBe("uint32, uint32, uint64");
  expect(idl.logs[0].type.fields.map((field) => field.name)).toEqual([
    "_contractIndex",
    "_type",
    "amount",
  ]);
  expect(idl.sysprocMask).toBe(1);
});

test("empty source still returns a complete v2 schema", () => {
  const empty = extractIdl("", "Empty");
  expect(empty).toMatchObject({
    version: QINIT_IDL_VERSION,
    name: "Empty",
    slot: 0,
    functions: [],
    procedures: [],
    enums: [],
    logs: [],
    dependencies: [],
  });
  expect(empty.state.fields).toEqual([]);
});

test("semantic failures surface through the adapter", () => {
  expect(() =>
    extractIdl(
      `struct CONTRACT_STATE_TYPE : ContractBase {
        struct Missing_input {};
        struct Missing_output {};
        REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
          REGISTER_USER_FUNCTION(Missing, 1);
        }
      };`,
      "Broken",
    ),
  ).toThrow(/no implementation body/);
});
