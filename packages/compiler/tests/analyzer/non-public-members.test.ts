// a typedef or struct a macro declares inherits the access in force at its call site: core's IMPLEMENT_SetShareholderProposal after a PRIVATE_* macro leaves SetShareholderProposal_input protected, which a gtest fixture cannot name.
import { expect, test } from "bun:test";
import type { MacroDef } from "../../src/frontend/preprocessor/preprocessor-context";
import { nonPublicMembers } from "../../src/analyzer/rules/protected-members";

const macro = (name: string, body: string): [string, MacroDef] => [name, { name, params: [], body, isVarArgs: false }];
const macros = new Map<string, MacroDef>([
    macro("PRIVATE_PROCEDURE", "protected: static void procedure()"),
    macro("PUBLIC_PROCEDURE", "public: static void procedure()"),
    macro("PUBLIC_FUNCTION", "public: static void function()"),
    macro("IMPLEMENT_SetX", "typedef uint16 SetX_input; typedef uint16 SetX_output; PUBLIC_PROCEDURE(SetX) { }"),
    macro("IMPLEMENT_GetX", "struct GetX_input { uint16 index; }; struct GetX_output { uint16 value; }; PUBLIC_FUNCTION(GetX) { }"),
    macro("IMPLEMENT_X", "IMPLEMENT_SetX() IMPLEMENT_GetX()"),
]);

const source = `using namespace QPI;
struct Leaf : public ContractBase {
    struct StateData { uint64 count; };
    struct Note_input {};
    struct Note_output {};
    PRIVATE_PROCEDURE(Note) { }
    struct Ask_input {};
    struct Ask_output {};
    IMPLEMENT_X()
    struct Open_input {};
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { }
};
`;

test("members a macro declares under the caller's protected access are non-public, those after its own public label are not", () => {
    const members = nonPublicMembers(source, "Leaf", macros);
    expect([...members.keys()].sort()).toEqual(["Ask_input", "Ask_output", "Note", "SetX_input", "SetX_output"]);
    expect(members.get("SetX_input")).toBe("declared by IMPLEMENT_SetX(…)");
});

test("a macro called while the contract is public declares public members", () => {
    const members = nonPublicMembers(source.replace("PRIVATE_PROCEDURE(Note) { }\n", "PUBLIC_PROCEDURE(Note) { }\n"), "Leaf", macros);
    expect(members.size).toBe(0);
});
