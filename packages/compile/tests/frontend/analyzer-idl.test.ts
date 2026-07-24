import { expect, test } from "bun:test";
import {
  AbiScalarKind,
  AbiTypeKind,
  parseContractIdl,
} from "../../../proto/src/contract-idl";
import { layoutOf } from "../../../proto/src/abi-fmt";
import { analyzeContract } from "../../src/analyzer";
import { compileContract } from "../../src/compiler/compile-contract";
import { QPI_SNAPSHOT } from "../../src/generated/qpi-snapshot";

const SOURCE = `
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  enum class Event : uint8 { Started = 2, Finished };

  struct Payload {
    uint16 code;
    uint64 amount;
  };

  struct EventLog {
    uint32 _type;
    Payload payload;
    sint8 _terminator;
  };

  struct StateData {
    HashMap<id, uint64, 4> balances;
    HashSet<uint32, 8> flags;
    Collection<Payload, 2> events;
    Array<uint16, 3> values;
  };

  struct Read_input { Payload request; };
  struct Read_output { uint64 amount; };
  PUBLIC_FUNCTION(Read) { output.amount = 0; }

  struct OldStateData { uint64 previous; };
  MIGRATE() {}

  INITIALIZE() {}

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 7);
  }
};
`;

test("analyzer and compiler publish the same authoritative v3 IDL", async () => {
  const analyzed = analyzeContract({
    source: SOURCE,
    name: "RichIdl",
    slot: 21,
  });

  expect(analyzed.diagnostics).toEqual([]);
  expect(analyzed.idl).toBeDefined();
  expect(() => parseContractIdl(analyzed.idl)).not.toThrow();

  const compiled = await compileContract({
    source: SOURCE,
    name: "RichIdl",
    slot: 21,
    qpiHeader: QPI_SNAPSHOT,
    arenaSz: 1 << 20,
  });

  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.idl).toEqual(analyzed.idl);

  const idl = analyzed.idl!;
  const entry = idl.functions[0];
  expect(entry.input.format).toBe("{ uint16, uint64 }");
  expect(entry.output.format).toBe("uint64");
  expect(entry.input.kind).toBe(AbiTypeKind.STRUCT);
  if (entry.input.kind !== AbiTypeKind.STRUCT) {
    throw new Error("Read input must remain a struct root");
  }
  expect(entry.input.fields[0].type.kind).toBe(AbiTypeKind.STRUCT);
  expect(idl.state.size).toBe(512);
  expect(idl.state.fields.map((field) => field.type.kind)).toEqual([
    AbiTypeKind.HASH_MAP,
    AbiTypeKind.HASH_SET,
    AbiTypeKind.COLLECTION,
    AbiTypeKind.ARRAY,
  ]);
  for (const field of idl.state.fields) {
    expect(layoutOf(field.type.format)).toEqual({
      size: field.type.size,
      align: field.type.align,
    });
  }
  expect(idl.enums).toEqual([
    {
      name: "Event",
      underlying: AbiScalarKind.UINT8,
      members: {
        "2": "Started",
        "3": "Finished",
      },
    },
  ]);
  expect(idl.logs[0]?.type.format).toBe(
    "uint32, { uint16, uint64 }",
  );
  expect(idl.migration?.oldState.format).toBe("uint64");
  expect(idl.sysprocMask).toBe(1);
});

test("emits exact scalar, array, and struct alias roots", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Payload {
    uint16 code;
    uint64 amount;
  };
  struct StateData {};

  typedef uint64 Scalar_input;
  using Scalar_output = sint64;
  typedef Array<uint16, 3> Values_input;
  using Values_output = Array<uint8, 4>;
  typedef Payload Record_input;
  using Record_output = Payload;

  struct Direct_input { uint8 value; };
  struct Direct_output { uint64 value; };

  PUBLIC_FUNCTION(Scalar) {}
  PUBLIC_FUNCTION(Values) {}
  PUBLIC_FUNCTION(Record) {}
  PUBLIC_FUNCTION(Direct) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Scalar, 1);
    REGISTER_USER_FUNCTION(Values, 2);
    REGISTER_USER_FUNCTION(Record, 3);
    REGISTER_USER_FUNCTION(Direct, 4);
  }
};`;

  const result = analyzeContract({
    source,
    name: "AliasRoots",
  });

  expect(result.diagnostics).toEqual([]);
  expect(() => parseContractIdl(result.idl)).not.toThrow();

  const entries = new Map(
    result.idl?.functions.map((entry) => [entry.name, entry]),
  );
  expect(entries.get("Scalar")?.input).toMatchObject({
    kind: AbiTypeKind.SCALAR,
    scalar: AbiScalarKind.UINT64,
    size: 8,
    format: "uint64",
  });
  expect(entries.get("Scalar")?.output).toMatchObject({
    kind: AbiTypeKind.SCALAR,
    scalar: AbiScalarKind.SINT64,
    size: 8,
    format: "sint64",
  });
  expect(entries.get("Values")?.input).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 3,
    size: 6,
    element: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT16,
    },
  });
  expect(entries.get("Values")?.output).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 4,
    size: 4,
    element: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT8,
    },
  });
  expect(entries.get("Record")?.input).toMatchObject({
    kind: AbiTypeKind.STRUCT,
    name: "Payload",
    size: 16,
    format: "uint16, uint64",
  });
  expect(entries.get("Direct")?.input).toMatchObject({
    kind: AbiTypeKind.STRUCT,
    name: "Direct_input",
    size: 1,
    format: "uint8",
  });
});

test("emits rare scalar, enum, array, and migration ABI types", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  enum Plain { PlainValue = 1 };
  enum class Tiny : uint8 { TinyValue = 2 };
  enum class Wide : uint64 { WideValue = 3 };
  using Alias = uint16;

  struct StateData;
  struct StateData {
    bit bitValue;
    id idValue;
    m256i m256iValue;
    uint8 uint8Value;
    uint16 uint16Value;
    uint32 uint32Value;
    uint64 uint64Value;
    uint128 uint128Value;
    sint8 sint8Value;
    sint16 sint16Value;
    sint32 sint32Value;
    sint64 sint64Value;
    bool boolValue;
    signed char signedCharValue;
    unsigned char unsignedCharValue;
    signed short signedShortValue;
    unsigned short unsignedShortValue;
    signed int signedIntValue;
    unsigned int unsignedIntValue;
    long long longLongValue;
    signed long long signedLongLongValue;
    unsigned long long unsignedLongLongValue;
    const Alias aliasValue;
    Plain plainValue;
    Tiny tinyValue;
    Wide wideValue;
    DateAndTime dateValue;
    BitArray<2> bits2;
    BitArray<64> bits64;
    BitArray<128> bits128;
    Array<uint128, 2> wideValues;
    Array<Array<uint16, 2>, 3> nestedValues;
    SlowAnySizeArray<uint16, 3> slowValues;
  };

  struct OldStateData;
  struct OldStateData {
    DateAndTime dateValue;
    SlowAnySizeArray<uint8, 3> bytes;
  };
  MIGRATE() {}
};`;

  const result = analyzeContract({
    source,
    name: "RareAbiTypes",
  });

  expect(result.diagnostics).toEqual([]);
  expect(() => parseContractIdl(result.idl)).not.toThrow();

  const fields = new Map(
    result.idl?.state.fields.map((field) => [field.name, field]),
  );
  const scalarCases: Array<[
    string,
    AbiScalarKind,
    number,
    number,
  ]> = [
    ["bitValue", AbiScalarKind.BIT, 1, 1],
    ["idValue", AbiScalarKind.ID, 32, 8],
    ["m256iValue", AbiScalarKind.M256I, 32, 8],
    ["uint8Value", AbiScalarKind.UINT8, 1, 1],
    ["uint16Value", AbiScalarKind.UINT16, 2, 2],
    ["uint32Value", AbiScalarKind.UINT32, 4, 4],
    ["uint64Value", AbiScalarKind.UINT64, 8, 8],
    ["uint128Value", AbiScalarKind.UINT128, 16, 8],
    ["sint8Value", AbiScalarKind.SINT8, 1, 1],
    ["sint16Value", AbiScalarKind.SINT16, 2, 2],
    ["sint32Value", AbiScalarKind.SINT32, 4, 4],
    ["sint64Value", AbiScalarKind.SINT64, 8, 8],
    ["boolValue", AbiScalarKind.UINT8, 1, 1],
    ["signedCharValue", AbiScalarKind.SINT8, 1, 1],
    ["unsignedCharValue", AbiScalarKind.UINT8, 1, 1],
    ["signedShortValue", AbiScalarKind.SINT16, 2, 2],
    ["unsignedShortValue", AbiScalarKind.UINT16, 2, 2],
    ["signedIntValue", AbiScalarKind.SINT32, 4, 4],
    ["unsignedIntValue", AbiScalarKind.UINT32, 4, 4],
    ["longLongValue", AbiScalarKind.SINT64, 8, 8],
    ["signedLongLongValue", AbiScalarKind.SINT64, 8, 8],
    ["unsignedLongLongValue", AbiScalarKind.UINT64, 8, 8],
    ["aliasValue", AbiScalarKind.UINT16, 2, 2],
    ["plainValue", AbiScalarKind.SINT32, 4, 4],
    ["tinyValue", AbiScalarKind.UINT8, 1, 1],
    ["wideValue", AbiScalarKind.UINT64, 8, 8],
    ["dateValue", AbiScalarKind.UINT64, 8, 8],
  ];

  for (const [name, scalar, size, align] of scalarCases) {
    expect(fields.get(name)?.type).toMatchObject({
      kind: AbiTypeKind.SCALAR,
      scalar,
      size,
      align,
    });
    expect(fields.get(name)?.size).toBe(size);
  }

  expect(fields.get("bits2")?.type).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 1,
    size: 8,
    element: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT64,
    },
  });
  expect(fields.get("bits64")?.type).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 1,
    size: 8,
  });
  expect(fields.get("bits128")?.type).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 2,
    size: 16,
  });
  expect(fields.get("wideValues")?.type).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 2,
    size: 32,
    element: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT128,
    },
  });
  expect(fields.get("nestedValues")?.type).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 3,
    size: 12,
    element: {
      kind: AbiTypeKind.ARRAY,
      count: 2,
      size: 4,
    },
  });
  expect(fields.get("slowValues")?.type).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 3,
    size: 6,
    element: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT16,
    },
  });
  expect(result.idl?.migration?.oldState).toMatchObject({
    size: 16,
    fields: [
      {
        name: "dateValue",
        offset: 0,
        size: 8,
      },
      {
        name: "bytes",
        offset: 8,
        size: 3,
        type: {
          kind: AbiTypeKind.ARRAY,
          count: 3,
        },
      },
    ],
  });
});

test("emits resolved dependent scalar types in ABI trees", () => {
  const source = `
using namespace QPI;
template <bool Flag>
struct Selector {
  typedef uint8 type;
};
template <bool Flag>
struct Box {
  typedef typename Selector<Flag>::type Value;
  Array<Value, 2> values;
};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
  struct Read_input {};
  typedef Box<false> Read_output;
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

  const result = analyzeContract({
    source,
    name: "DependentAbiType",
  });
  const output = result.idl?.functions[0]?.output;

  expect(result.diagnostics).toEqual([]);
  expect(output?.kind).toBe(AbiTypeKind.STRUCT);
  if (output?.kind !== AbiTypeKind.STRUCT) {
    throw new Error("Read output must resolve to a struct");
  }
  expect(output.fields[0]?.type).toMatchObject({
    kind: AbiTypeKind.ARRAY,
    count: 2,
    size: 2,
    element: {
      kind: AbiTypeKind.SCALAR,
      scalar: AbiScalarKind.UINT8,
      size: 1,
    },
  });
  expect(() => parseContractIdl(result.idl)).not.toThrow();
});

test("uses semantic registration constants for IDL and policy checks", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  static constexpr uint64 READ_INDEX = 7;
  struct Read_input {};
  struct Read_output {};
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, READ_INDEX);
  }
};`;

  const result = analyzeContract({
    source,
    name: "NamedRegistration",
  });

  expect(result.idl?.functions[0]?.inputType).toBe(7);
  expect(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "qpi/unregistered",
    ),
  ).toBe(false);
});

test("keeps hexadecimal registration indices distinct", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Read_input {};
  struct Read_output {};
  struct Other_input {};
  struct Other_output {};
  PUBLIC_FUNCTION(Read) {}
  PUBLIC_FUNCTION(Other) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 0x10);
    REGISTER_USER_FUNCTION(Other, 0x20);
  }
};`;

  const result = analyzeContract({
    source,
    name: "HexRegistrations",
  });

  expect(
    result.idl?.functions.map((entry) => entry.inputType),
  ).toEqual([0x10, 0x20]);
  expect(
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "qpi/dup-fn-index",
    ),
  ).toBe(false);
});

test("rejects registration constants with unresolved dependencies", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  static constexpr uint64 READ_INDEX = MISSING_INDEX + 1;
  struct Read_input {};
  struct Read_output {};
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, READ_INDEX);
  }
};`;

  const result = analyzeContract({
    source,
    name: "InvalidRegistration",
  });

  expect(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.message.includes("integral constant expression"),
    ),
  ).toBe(true);
  expect(result.idl).toBeUndefined();
});

test("keeps namespace-qualified nested ABI types distinct", () => {
  const qpiHeader = `${QPI_SNAPSHOT}
namespace BuildTestOI {
  struct Price {
    struct OracleQuery { id oracle; uint64 timestamp; };
  };
  struct Mock {
    struct OracleQuery { uint64 value; };
  };
}`;
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Ask_input {
    BuildTestOI::Price::OracleQuery price;
    BuildTestOI::Mock::OracleQuery mock;
  };
  struct Ask_output {};
  PUBLIC_PROCEDURE(Ask) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Ask, 1);
  }
};`;

  const result = analyzeContract({
    source,
    name: "OracleUser",
    qpiHeader,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.idl?.procedures[0]?.input.format).toBe(
    "{ id, uint64 }, { uint64 }",
  );
});

test("keeps same-named nested array element layouts distinct", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Smaller_input {};
  struct Smaller_output {
    struct Order {
      id issuer;
      sint64 price;
      sint64 shares;
    };
    Array<Order, 2> orders;
  };

  struct Larger_input {};
  struct Larger_output {
    struct Order {
      id issuer;
      uint64 assetName;
      sint64 price;
      sint64 shares;
    };
    Array<Order, 2> orders;
  };

  PUBLIC_FUNCTION(Smaller) {}
  PUBLIC_FUNCTION(Larger) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Smaller, 1);
    REGISTER_USER_FUNCTION(Larger, 2);
  }
};`;

  const result = analyzeContract({
    source,
    name: "NestedArrays",
  });

  expect(result.diagnostics).toEqual([]);
  const smaller = result.idl?.functions.find((entry) => entry.name === "Smaller");
  const larger = result.idl?.functions.find((entry) => entry.name === "Larger");

  expect(smaller?.output.kind).toBe(AbiTypeKind.STRUCT);
  expect(larger?.output.kind).toBe(AbiTypeKind.STRUCT);
  if (
    smaller?.output.kind !== AbiTypeKind.STRUCT ||
    larger?.output.kind !== AbiTypeKind.STRUCT
  ) {
    throw new Error("nested array outputs must remain struct roots");
  }

  expect(smaller.output.fields[0]).toMatchObject({
    size: 96,
    type: {
      kind: AbiTypeKind.ARRAY,
      size: 96,
      element: {
        kind: AbiTypeKind.STRUCT,
        size: 48,
      },
    },
  });
  expect(larger.output.fields[0]).toMatchObject({
    size: 112,
    type: {
      kind: AbiTypeKind.ARRAY,
      size: 112,
      element: {
        kind: AbiTypeKind.STRUCT,
        size: 56,
      },
    },
  });
});

test("resolves dependent array lengths in generic ABI types", () => {
  const source = `
using namespace QPI;
template <typename T, uint64 L>
struct FixedValues {
  Array<T, L> values;
};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    FixedValues<uint16, 3> fixed;
  };
};`;

  const result = analyzeContract({
    source,
    name: "GenericLayout",
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.idl?.state.fields[0]?.type).toMatchObject({
    kind: AbiTypeKind.STRUCT,
    fields: [
      {
        type: {
          kind: AbiTypeKind.ARRAY,
          count: 3,
        },
      },
    ],
  });
});

test("does not publish IDL when layout analysis reports an error", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { Array<uint64, UNKNOWN_CAPACITY> values; };
  struct Read_input {};
  struct Read_output {};
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

  const result = analyzeContract({
    source,
    name: "InvalidLayout",
  });

  expect(
    result.diagnostics.some((diagnostic) => (
      diagnostic.message.includes("UNKNOWN_CAPACITY")
    )),
  ).toBe(true);
  expect(result.idl).toBeUndefined();
});

test("rejects positive array lengths containing unresolved constants", () => {
  const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    Array<uint64, UNKNOWN_CAPACITY + 1> values;
  };
};`;

  const result = analyzeContract({
    source,
    name: "InvalidExpressionLayout",
  });

  expect(
    result.diagnostics.some((diagnostic) => (
      diagnostic.message.includes("array length")
    )),
  ).toBe(true);
  expect(result.idl).toBeUndefined();
});
