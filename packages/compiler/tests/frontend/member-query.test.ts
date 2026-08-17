import { expect, test } from "bun:test";
import { completeMembersAt, completeMembersOfType, declaredTypeOf, MemberCompletionKind, splitReceiver, type MemberCompletion } from "../../src/analyzer";

// No qpiHeader is passed: the generated snapshot is the default, so these run without a core checkout.
const CONTRACT = `using namespace QPI;

struct Bank : public ContractBase {
    struct StateData {
        HashMap<id, uint64, 1024> balances;
        Array<uint64, 4> recent;
        uint64 total;
    };

    struct Set_input { id who; uint64 amount; };
    struct Set_output {};

    PUBLIC_PROCEDURE(Set)
    {
        MARKER
        state.mut().total += input.amount;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Set, 1); }
};
`;

const CALLEE = `using namespace QPI;

struct Counter : public ContractBase {
    struct StateData { uint64 counter; };
    struct Get_input { Array<uint64, 8> bc; sint16 a; };
    struct Get_output { uint64 value; };

    PUBLIC_FUNCTION(Get) { output.value = state.get().counter; }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};
`;

const CALLER = `using namespace QPI;

struct CrossCall : public ContractBase {
    struct StateData { uint64 dummy; };
    struct Read_input {};
    struct Read_output { uint64 value; };
    struct Read_locals { Counter::Get_input gi; Counter::Get_output go; };

    PUBLIC_FUNCTION_WITH_LOCALS(Read)
    {
        MARKER
        output.value = locals.go.value;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Read, 1); }
};
`;

/** Complete at the end of `receiver`, substituted for the contract's MARKER line. */
function complete(template: string, contractName: string, receiver: string, calleeSources?: Array<{ name: string; source: string; slot?: number }>) {
    const source = template.replace("MARKER", receiver);
    const offset = source.indexOf(receiver) + receiver.length;
    return completeMembersAt({ source, offset, contractName, slot: 28, calleeSources });
}

function names(items: MemberCompletion[] | undefined): string[] {
    return (items ?? []).filter((item) => !item.name.startsWith("_")).map((item) => item.name);
}

test("completes a HashMap reached through contract state", () => {
    const items = complete(CONTRACT, "Bank", "state.mut().balances.");

    expect(names(items)).toEqual(expect.arrayContaining(["set", "get", "contains", "population", "removeByKey"]));
    const set = items!.find((item) => item.name === "set")!;
    expect(set.kind).toBe(MemberCompletionKind.METHOD);
    expect(set.typeText).toBe("sint64");
    // Template parameters read back as spelled, not as their resolved types (`m256i`, `unsigned long long`).
    expect(set.parameters).toEqual(["const id& key", "const uint64& value"]);
});

test("completes the other template containers and reads their non-type arguments", () => {
    expect(names(complete(CONTRACT, "Bank", "state.get().recent."))).toEqual(expect.arrayContaining(["capacity", "get", "set"]));

    const total = complete(CONTRACT, "Bank", "state.mut().")!.find((item) => item.name === "total");
    expect(total).toEqual({ name: "total", kind: MemberCompletionKind.FIELD, typeText: "uint64", parameters: [] });
    const balances = complete(CONTRACT, "Bank", "state.mut().")!.find((item) => item.name === "balances");
    expect(balances?.typeText).toBe("HashMap<id, uint64, 1024>");
});

test("completes procedure parameters", () => {
    expect(names(complete(CONTRACT, "Bank", "input."))).toEqual(["who", "amount"]);
    expect(names(complete(CONTRACT, "Bank", "output."))).toEqual([]);
});

// The repro the clang fallback was written for: a callee's input struct reached through locals.
test("completes a callee contract's struct reached through locals", () => {
    const callees = [{ name: "Counter", source: CALLEE, slot: 29 }];

    expect(names(complete(CALLER, "CrossCall", "locals.gi.", callees))).toEqual(["bc", "a"]);
    expect(names(complete(CALLER, "CrossCall", "locals.gi.bc.", callees))).toEqual(expect.arrayContaining(["capacity", "get", "set"]));
});

// A contract body is mostly branches and loops, so the receiver is rarely a top-level statement.
test("completes inside branches and loops", () => {
    for (const block of [
        "if (input.amount > 0)\n        {\n            state.mut().balances.\n        }",
        "while (input.amount > 0)\n        {\n            state.mut().balances.\n        }",
        "for (sint64 i = 0; i < 4; i++)\n        {\n            state.mut().balances.\n        }",
    ]) {
        const source = CONTRACT.replace("MARKER", block);
        const receiver = "state.mut().balances.";
        const items = completeMembersAt({ source, offset: source.indexOf(receiver) + receiver.length, contractName: "Bank", slot: 28 });

        expect(names(items)).toContain("set");
    }
});

test("answers a truncated buffer, since completion runs mid-edit", () => {
    const source = `${CONTRACT.slice(0, CONTRACT.indexOf("MARKER"))}state.mut().balances.`;

    const items = completeMembersAt({ source, offset: source.length, contractName: "Bank", slot: 28 });

    expect(names(items)).toContain("set");
});

test("offers neither constructors nor operators", () => {
    const items = names(complete(CONTRACT, "Bank", "state.mut().balances."));

    expect(items).not.toContain("HashMap");
    expect(items.filter((name) => name.startsWith("operator"))).toEqual([]);
});

test("returns undefined rather than an empty list when nothing resolves", () => {
    expect(complete(CONTRACT, "Bank", "notAThing.")).toBeUndefined();
    // A scalar field has no members to reach through; `id` is a struct, so it is not this case.
    expect(complete(CONTRACT, "Bank", "input.amount.")).toBeUndefined();
    // No member operator sits at the cursor.
    expect(completeMembersAt({ source: CONTRACT, offset: 12, contractName: "Bank", slot: 28 })).toBeUndefined();
});

// The gtest seam: nothing here is a contract, so the root's type arrives as text and the hops after it
// are walked by the compiler. This is the shape the clangd bug answers with an empty list.
const CALLEES = [{ name: "Counter", source: CALLEE, slot: 29 }];

function ofType(rootTypeText: string, path: string[] = []): string[] | undefined {
    const items = completeMembersOfType({ rootTypeText, path, calleeSources: CALLEES });
    return items && names(items);
}

test("completes from a root type spelled by a language server", () => {
    expect(ofType("Counter::Get_input")).toEqual(["bc", "a"]);
    expect(ofType("Counter::Get_input", ["bc"])).toEqual(expect.arrayContaining(["capacity", "get", "set"]));
    // Every form clangd prints for a receiver: a reference, a const reference and a namespaced template.
    expect(ofType("Counter::Get_input &", ["bc"])).toContain("set");
    expect(ofType("const Counter::Get_input &", ["bc"])).toContain("set");
    expect(ofType("QPI::Array<unsigned long long, 8>")).toContain("setAll");
});

// The upstream Quottery shape: an input struct holding a sibling struct spelled bare, which is
// registered qualified (`Quote::Info`) and so only resolves under its contract's scope.
test("completes a sibling struct the contract spells without its qualifier", () => {
    const source = `using namespace QPI;

struct Quote : public ContractBase {
    struct StateData { uint64 dummy; };
    struct Info { Array<uint64, 8> bc; sint16 tag; };
    struct Make_input { Info info; };
    struct Make_output {};

    PUBLIC_PROCEDURE(Make) {}

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Make, 1); }
};
`;
    const callees = [{ name: "Quote", source, slot: 31 }];
    const at = (rootTypeText: string, path: string[]) => names(completeMembersOfType({ rootTypeText, path, calleeSources: callees }));

    expect(at("Quote::Make_input", ["info"])).toEqual(["bc", "tag"]);
    expect(at("Quote::Make_input", ["info", "bc"])).toContain("setAll");
});

test("answers nothing for a type it cannot resolve", () => {
    // `auto` clangd could not deduce, an unknown name, and a hop that is not a member.
    expect(ofType("auto &")).toBeUndefined();
    expect(ofType("Counter::NotAThing")).toBeUndefined();
    expect(ofType("Counter::Get_input", ["nope"])).toBeUndefined();
});

// A language server drops the statement being typed into, so hover on the root answers nothing exactly
// when completion runs. The declaration in the text is what stays readable.
test("reads a root's declared type out of the source text", () => {
    const typeOf = (source: string, name: string) => declaredTypeOf(source, source.length, name);

    expect(typeOf("    Counter::Get_input gi;\n    gi.", "gi")).toBe("Counter::Get_input");
    expect(typeOf("{\n    const Counter::Get_input& ref = gi;\n    ref.", "ref")).toBe("const Counter::Get_input&");
    expect(typeOf("    Array<uint64, 8> arr;\n    arr.", "arr")).toBe("Array<uint64, 8>");
    expect(typeOf("    HashMap<id, uint64, 1024> m;\n    m.", "m")).toBe("HashMap<id, uint64, 1024>");
    expect(typeOf("    Counter::Get_input gi(1);\n    gi.", "gi")).toBe("Counter::Get_input");
    expect(typeOf("void f(const Counter::Get_input& gi)\n{\n    gi.", "gi")).toBe("const Counter::Get_input&");
    // The half-typed statement above the cursor leaves a dangling `.`, which must not hide the next
    // declaration — this is the state the buffer is actually in while a member list is requested.
    expect(typeOf("    Counter::Get_input a;\n    a.x.\n\n    const Counter::Get_input& r = a;\n    r.", "r")).toBe("const Counter::Get_input&");
    // The nearest declaration before the cursor wins, and an undeclared name resolves to nothing.
    expect(typeOf("    sint16 v;\n    Counter::Get_input v;\n    v.", "v")).toBe("Counter::Get_input");
    expect(typeOf("    other.field = 1;\n    gi.", "gi")).toBeUndefined();
});

test("splits a receiver into its root and plain-identifier hops", () => {
    const at = (text: string) => splitReceiver(text, text.length);

    expect(at("    cei.qei.")).toEqual({ rootText: "cei", rootOffset: 4, path: ["qei"] });
    expect(at("a->b.c.q")).toEqual({ rootText: "a", rootOffset: 0, path: ["b", "c"] });
    // A call or subscript is kept whole inside the root, but is never accepted as a hop.
    expect(at("f(x.y).z.")).toEqual({ rootText: "f(x.y)", rootOffset: 0, path: ["z"] });
    expect(at("t.fixture().out.")).toBeUndefined();
    expect(at("no member operator")).toBeUndefined();
});
