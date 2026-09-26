// GQMPROP's `typedef Success_output Vote_output` leaked its bare name into every sibling, so `qinit state QUTIL` failed on QUTIL's own Vote_output.
import { expect, test } from "bun:test";
import { extractIdl, parseContractIdl } from "../../src/compile/idl";

const gov = `struct Gov2 {};
struct Gov : public ContractBase {
    struct Success_output { bit okay; uint8 pad; };
    typedef Success_output Vote_output;
    struct Vote_input { uint32 v; };
    PUBLIC_PROCEDURE(Vote) { output.okay = 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Vote, 1); }
};`;

const main = (stateFields: string) => `struct Main2 {};
struct Main : public ContractBase {
    struct Vote_input { uint32 v; };
    struct Vote_output { uint64 total; };
    struct StateData { ${stateFields} };
    PUBLIC_PROCEDURE(Vote) { output.total = input.v; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Vote, 1); }
};`;

const idlOf = (stateFields: string) => {
    const idl = extractIdl(main(stateFields), "Main", { slot: 30, calleeSources: [{ name: "Gov", source: gov, slot: 29 }] });
    expect(() => parseContractIdl(idl)).not.toThrow();
    return idl;
};

test("a callee's member typedef does not claim the bare name the contract declares itself", () => {
    const idl = idlOf("uint64 total;");
    expect(idl.procedures.find((entry) => entry.name === "Vote")?.outSize).toBe(8);
});

test("a qualified callee typedef resolves its target in the callee's scope", () => {
    expect(idlOf("uint64 total; Gov::Vote_output last;").state.fields.map((field) => [field.name, field.size])).toEqual([
        ["total", 8],
        ["last", 2],
    ]);
});
