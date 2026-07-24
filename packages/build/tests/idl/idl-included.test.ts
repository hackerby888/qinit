import { expect, test } from "bun:test";
import { qpiSnapshot } from "@qinit/compile/browser";
import { AbiTypeKind, extractIdl } from "../../src/idl";

test("qpiHeader supplies ambient namespace-qualified ABI types", () => {
  const qpiHeader = `${qpiSnapshot}
namespace BuildTestOI {
  struct Price {
    struct OracleQuery {
      id oracle;
      uint64 timestamp;
    };
  };
  struct Mock {
    struct OracleQuery {
      uint64 value;
    };
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

  const input = extractIdl(source, "OracleUser", { qpiHeader }).procedures[0].input;
  if (input.kind !== AbiTypeKind.STRUCT) {
    throw new Error("Ask_input must be a struct");
  }
  expect(input.format).toBe("{ id, uint64 }, { uint64 }");
  expect(input.fields.map((field) => field.name)).toEqual(["price", "mock"]);

  const price = input.fields[0].type;
  expect(price.kind).toBe(AbiTypeKind.STRUCT);
  if (price.kind === AbiTypeKind.STRUCT) {
    expect(price.fields.map((field) => field.name)).toEqual(["oracle", "timestamp"]);
  }

  const mock = input.fields[1].type;
  expect(mock.kind).toBe(AbiTypeKind.STRUCT);
  if (mock.kind === AbiTypeKind.STRUCT) {
    expect(mock.fields.map((field) => field.name)).toEqual(["value"]);
  }
});
