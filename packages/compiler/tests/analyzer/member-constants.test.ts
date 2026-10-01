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
