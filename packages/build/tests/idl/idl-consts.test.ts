import { expect, test } from "bun:test";
import { AbiTypeKind, extractIdl } from "../../src/idl";

test("constexpr QPI math resolves array lengths in the v3 type tree", () => {
  const source = `
using namespace QPI;
constexpr uint64 MAX_VALUES = 1024;
constexpr uint64 GROUPS = 4;
constexpr uint64 VALUE_COUNT = div(MAX_VALUES, 4) * GROUPS;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Measure_input { Array<uint8, VALUE_COUNT> values; };
  struct Measure_output {};
  PUBLIC_PROCEDURE(Measure) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Measure, 1);
  }
};`;

  const input = extractIdl(source, "Constants").procedures[0].input;
  if (input.kind !== AbiTypeKind.STRUCT) {
    throw new Error("Measure_input must be a struct");
  }
  expect(input.format).toBe("[1024;uint8]");
  const values = input.fields[0].type;
  expect(values.kind).toBe(AbiTypeKind.ARRAY);
  if (values.kind === AbiTypeKind.ARRAY) {
    expect(values.count).toBe(1024);
    expect(values.element.format).toBe("uint8");
  }
});

test("templated and plain constexpr helpers resolve consistently", () => {
  const source = `
using namespace QPI;
constexpr uint64 N = 12;
constexpr uint64 A = div<uint64>(N, 2);
constexpr uint64 B = mod(N, 3);
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Measure_input { Array<uint8, A> a; Array<uint8, B> b; };
  struct Measure_output {};
  PUBLIC_PROCEDURE(Measure) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Measure, 1);
  }
};`;

  const input = extractIdl(source, "Constants").procedures[0].input;
  if (input.kind !== AbiTypeKind.STRUCT) {
    throw new Error("Measure_input must be a struct");
  }
  expect(input.format).toBe("[6;uint8], [0;uint8]");
  expect(input.fields.map((field) => field.type.size)).toEqual([6, 0]);
});
