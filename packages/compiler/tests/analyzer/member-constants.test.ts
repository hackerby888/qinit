// A nested struct's own static constexpr sizes its members: class scope comes before namespace scope, so `k` is not QPI's Ch::k (107),
// and a longer name (DogeShareValidation's additionalDataSize) resolves at all.
import { expect, test } from "bun:test";
import { analyzeContract } from "../../src/analyzer";

function analyze(member: string, name = "k") {
    const source = `using namespace QPI;
struct T2 {};
struct T : public ContractBase {
  struct Q { static constexpr uint64 ${name} = 16 - sizeof(uint64); ${member}<uint8, ${name}> a; };
  struct StateData { Q q; };
  struct Get_input {}; struct Get_output { uint64 v; };
  PUBLIC_FUNCTION(Get) { output.v = sizeof(Q); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;
    const result = analyzeContract({ source, contractName: "T", slot: 28 });
    return { errors: result.diagnostics.filter((item) => item.severity === "error").map((item) => item.message), size: result.idl?.state?.size };
}

test("a one-letter member constant sizes the array, not the enumerator of the same name", () => {
    expect(analyze("SlowAnySizeArray")).toEqual({ errors: [], size: 8 });
    expect(analyze("SlowAnySizeArray", "n")).toEqual({ errors: [], size: 8 });
    expect(analyze("Array")).toEqual({ errors: [], size: 8 });
});

test("a longer member constant resolves", () => {
    expect(analyze("SlowAnySizeArray", "additionalSize")).toEqual({ errors: [], size: 8 });
});

test("DogeShareValidation's query can be used", () => {
    const source = `using namespace QPI;
struct T2 {};
struct T : public ContractBase {
  struct StateData { OI::DogeShareValidation::OracleQuery q; };
  struct Get_input {}; struct Get_output { uint64 v; };
  PUBLIC_FUNCTION(Get) { output.v = sizeof(OI::DogeShareValidation::OracleQuery); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;
    const result = analyzeContract({ source, contractName: "T", slot: 28 });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
});

test("the recorded field type carries the member constant's value, so a later method call sees 8, not the enumerator", () => {
    const source = `using namespace QPI;
struct T2 {};
struct T : public ContractBase {
  struct Q { static constexpr uint64 k = 8; Array<uint8, k> a; };
  struct StateData { Q q; };
  struct Get_input {}; struct Get_output { uint64 v; };
  PUBLIC_FUNCTION(Get) { output.v = state.get().q.a.capacity(); }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;
    const result = analyzeContract({ source, contractName: "T", slot: 28 });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const field = result.idl!.state.fields[0];
    expect(JSON.stringify(field.type)).not.toContain("107");
});

// a struct's constants are its own: a struct holding it, a container instantiated over it and a base deriving from it do not hand theirs down.
function layout(body: string) {
    const source = `using namespace QPI;
struct T2 {};
struct T : public ContractBase {
${body}
  struct Get_input {}; struct Get_output { uint64 v; };
  PUBLIC_FUNCTION(Get) { output.v = 1; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};`;
    const result = analyzeContract({ source, contractName: "T", slot: 28 });
    return { errors: result.diagnostics.filter((item) => item.severity === "error").length, size: result.idl?.state?.size };
}

test("a field's struct is sized by its own constant, not the holder's of the same name", () => {
    const held = "struct A { static constexpr uint64 N = 4; Array<uint8, N> a; };";
    expect(layout(`${held} struct B { static constexpr uint64 N = 8; A inner; Array<uint8, N> b; }; struct StateData { B b; };`)).toEqual({ errors: 0, size: 12 });
    expect(layout(`${held} struct StateData { static constexpr uint64 N = 8; A inner; Array<uint8, N> b; };`)).toEqual({ errors: 0, size: 12 });
    expect(layout(`${held} struct StateData { static constexpr uint64 N = 8; Array<uint8, N> b; A inner; };`)).toEqual({ errors: 0, size: 12 });
    expect(layout(`${held} struct B : public A { static constexpr uint64 N = 8; Array<uint8, N> b; }; struct StateData { B b; };`)).toEqual({ errors: 0, size: 12 });
});

test("a nested struct's own constant wins over the enclosing one's, which it sees when it has none", () => {
    const outer = (inner: string) => `struct Outer { static constexpr uint64 N = 16; struct Inner { ${inner} Array<uint8, N> a; }; Inner i; Array<uint8, N> b; }; struct StateData { Outer o; };`;
    expect(layout(outer("static constexpr uint64 N = 4;"))).toEqual({ errors: 0, size: 20 });
    expect(layout(outer(""))).toEqual({ errors: 0, size: 32 });
    // the same Inner reads the same whether it is reached through Outer or named from outside it
    expect(layout(`struct Outer { static constexpr uint64 N = 16; struct Inner { Array<uint8, N> a; }; }; struct StateData { Outer::Inner i; };`)).toEqual({ errors: 0, size: 16 });
});

test("a container's parameter does not replace the element's constant of the same name", () => {
    expect(layout(`struct Q { static constexpr uint64 L = 4; Array<uint64, L> a; }; struct StateData { Array<Q, 8> qs; };`)).toEqual({ errors: 0, size: 256 });
});

test("a struct with no constant of its own does not take one from the struct that holds it", () => {
    const leaked = layout(`struct A { Array<uint8, k> a; }; struct B { static constexpr uint64 k = 8; A inner; }; struct StateData { B b; };`);
    expect(leaked.errors).toBeGreaterThan(0);
});
