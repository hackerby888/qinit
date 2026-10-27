import { expect, test } from "bun:test";
import { genStdGtest } from "../../src/generate/std-gtest";
import { extractIdl } from "../../src/compile/idl";

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
    expect(output).toContain("callFunction(Counter_CONTRACT_INDEX, 9, in, out);");
    expect(output).toContain("invokeUserProcedure(Counter_CONTRACT_INDEX, 7, in, out, user, amount);");
    expect(output).toContain("TEST(Counter, Read)");
    expect(output).toContain("TEST(Counter, Write)");
});

// a fixture cannot name `Counter::Write_input` when a PRIVATE_* macro left it protected, so the entry is listed instead of scaffolded
test("an entry whose io types are not public is listed instead of scaffolded", () => {
    const scaffold = genStdGtest(extractIdl(source, "Counter"), "Counter", "Counter", new Set(["Write_input"]));
    expect(scaffold).toContain("// not scaffolded: Write —");
    expect(scaffold).toContain("TEST(Counter, Read)");
    expect(scaffold).not.toContain("TEST(Counter, Write)");
    expect(scaffold).not.toContain("Write_input");
});

test("a notification procedure gets no wrapper and no TEST", () => {
    const idl = extractIdl(source, "Counter");
    idl.procedures.find((entry) => entry.name === "Write")!.notification = true;
    const scaffold = genStdGtest(idl, "Counter");
    expect(scaffold).toContain("TEST(Counter, Read)");
    expect(scaffold).not.toContain("TEST(Counter, Write)");
    expect(scaffold).not.toContain("invokeUserProcedure");
});

// a callee's state is zero in the harness until the fixture initializes it, as core's own tests do before the contract under test
test("a dependency is initialized before the contract", () => {
    const withCallee = genStdGtest({ ...extractIdl(source, "Counter"), dependencies: ["QX"] }, "Counter");

    expect(withCallee).toContain("        INIT_CONTRACT(QX);\n        callSystemProcedure(QX_CONTRACT_INDEX, INITIALIZE);\n        INIT_CONTRACT(Counter);");
});
