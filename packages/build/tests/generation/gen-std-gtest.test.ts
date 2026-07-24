import { expect, test } from "bun:test";
import { genStdGtest } from "../../src/gen-std-gtest";
import { extractIdl } from "../../src/idl";

const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Read_input {};
  struct Read_output { uint64 value; };
  struct Write_input { uint64 value; };
  struct Write_output {};
  PUBLIC_FUNCTION(Read) {}
  PUBLIC_PROCEDURE(Write) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 9);
    REGISTER_USER_PROCEDURE(Write, 7);
  }
};`;

const output = genStdGtest(extractIdl(source, "Counter"), "Counter");

test("gtest generator reads v3 entry arrays and input types", () => {
  expect(output).toContain(
    "callFunction(Counter_CONTRACT_INDEX, 9, in, out);",
  );
  expect(output).toContain(
    "invokeUserProcedure(Counter_CONTRACT_INDEX, 7, in, out, user, amount);",
  );
  expect(output).toContain("TEST(Counter, Read)");
  expect(output).toContain("TEST(Counter, Write)");
});
