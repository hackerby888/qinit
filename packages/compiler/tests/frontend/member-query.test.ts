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

// The gtest seam: nothing here is a contract, so the root's type arrives as text and later hops are walked by the compiler — the clangd-bug shape.
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

// The upstream Quottery shape: an input struct holding a sibling struct spelled bare, registered qualified and so resolving only under its contract's scope.
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

// A language server drops the statement being typed into, so hover on the root answers nothing exactly when completion runs; the declaration in text stays.
test("reads a root's declared type out of the source text", () => {
    const typeOf = (source: string, name: string) => declaredTypeOf(source, source.length, name);

    expect(typeOf("    Counter::Get_input gi;\n    gi.", "gi")).toBe("Counter::Get_input");
    expect(typeOf("{\n    const Counter::Get_input& ref = gi;\n    ref.", "ref")).toBe("const Counter::Get_input&");
    expect(typeOf("    Array<uint64, 8> arr;\n    arr.", "arr")).toBe("Array<uint64, 8>");
    expect(typeOf("    HashMap<id, uint64, 1024> m;\n    m.", "m")).toBe("HashMap<id, uint64, 1024>");
    expect(typeOf("    Counter::Get_input gi(1);\n    gi.", "gi")).toBe("Counter::Get_input");
    expect(typeOf("void f(const Counter::Get_input& gi)\n{\n    gi.", "gi")).toBe("const Counter::Get_input&");
    // The half-typed statement above the cursor leaves a dangling `.`, which must not hide the next declaration — the state the buffer is in while listing.
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

// The query rewrites the receiver's line into a statement of its own. A one-line entry body carries the macro
// and both braces on that line, so replacing it stopped the contract parsing — four of core's thirty-five.
test("a receiver inside a one-line entry body still resolves", () => {
    const inline = `using namespace QPI;
struct Ledger2 {};
struct Ledger : public ContractBase {
    struct Note { uint64 amount; uint8 kind; };
    struct StateData { uint64 calls; Note last; };
    struct Go_input {}; struct Go_output {};
    struct Go_locals { Note note; };
    PUBLIC_PROCEDURE_WITH_LOCALS(Go) { locals.note.amount = 0; state.mut().calls += 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Go, 1); }
};
`;
    const at = (receiver: string) =>
        completeMembersAt({ source: inline, offset: inline.indexOf(receiver) + receiver.length, contractName: "Ledger", slot: 28 });

    expect(at("locals.note.")?.map((item) => item.name)).toEqual(["amount", "kind"]);
    expect(at("state.mut().")?.map((item) => item.name)).toEqual(["calls", "last"]);

    // The same contract across lines answered before this fix and must answer identically after it.
    const spread = inline.replace(
        "PUBLIC_PROCEDURE_WITH_LOCALS(Go) { locals.note.amount = 0; state.mut().calls += 1; }",
        "PUBLIC_PROCEDURE_WITH_LOCALS(Go)\n    {\n        locals.note.amount = 0;\n        state.mut().calls += 1;\n    }",
    );
    const spreadAt = completeMembersAt({ source: spread, offset: spread.indexOf("locals.note.") + "locals.note.".length, contractName: "Ledger", slot: 28 });
    expect(spreadAt?.map((item) => item.name)).toEqual(["amount", "kind"]);
});

// A preprocessor directive emits nothing, and dropping its own line shifted every remap below it: core's
// QUtil.h has a `#if 0` block at line 77, and every one of the 139 member positions under it declined.
test("a preprocessor directive above the cursor does not silence the member query", () => {
    const build = (parked: string) => `using namespace QPI;
${parked}
struct Desk2 {};
struct Desk : public ContractBase
{
    struct StateData { uint64 alpha; uint64 beta; };
    struct Go_input {}; struct Go_output { uint64 v; };
    PUBLIC_FUNCTION(Go)
    {
        output.v = state.get().alpha;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Go, 1); }
};
`;
    const members = (parked: string) => {
        const source = build(parked);
        const marker = "state.get().";
        return completeMembersAt({ source, offset: source.indexOf(marker) + marker.length, contractName: "Desk", slot: 28 })?.map((item) => item.name);
    };

    expect(members("")).toEqual(["alpha", "beta"]);
    expect(members("#define PARKED 1")).toEqual(["alpha", "beta"]);
    expect(members("#if 0\nstruct Parked { uint64 x; };\n#endif")).toEqual(["alpha", "beta"]);
    expect(members("#if 0\nstruct A { uint64 x; };\nstruct B { uint64 y; };\nstruct C { uint64 z; };\n#endif")).toEqual(["alpha", "beta"]);
});

// The same shift from the other direction: a macro invocation spanning lines consumes them and emits one.
// QPayhub.h's three-line `SUBSCRIBE_ORACLE(...)` silenced all 53 `state.` receivers below it.
test("a macro invocation spanning lines does not silence the receivers below it", () => {
    const build = (register: string) => `using namespace QPI;
struct Desk2 {};
struct Desk : public ContractBase
{
    struct StateData { uint64 alpha; uint64 beta; };
    struct First_input {}; struct First_output { uint64 v; };
    struct Second_input {}; struct Second_output { uint64 v; };
    PUBLIC_FUNCTION(First) { output.v = 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { ${register} }
    PUBLIC_FUNCTION(Second)
    {
        output.v = state.get().beta;
    }
};
`;
    const members = (register: string) => {
        const source = build(register);
        const marker = "state.get().";
        return completeMembersAt({ source, offset: source.indexOf(marker) + marker.length, contractName: "Desk", slot: 28 })?.map((item) => item.name);
    };

    expect(members("REGISTER_USER_FUNCTION(First, 1); REGISTER_USER_FUNCTION(Second, 2);")).toEqual(["alpha", "beta"]);
    expect(
        members("REGISTER_USER_FUNCTION(\n            First,\n            1);\n        REGISTER_USER_FUNCTION(\n            Second,\n            2);"),
    ).toEqual(["alpha", "beta"]);
});

// Shapes the receiver walk used to take too much of, measured on core: it keeps `-` because `->` needs it,
// so `-state.get()` was resolved whole, and a C-style cast reads as a call's parentheses from the back.
test("a prefix operator or a cast is not part of the receiver", () => {
    const body = (line: string) => `using namespace QPI;
struct Desk2 {};
struct Desk : public ContractBase
{
    struct StateData { uint64 alpha; sint64 beta; };
    struct Go_input { uint64 n; }; struct Go_output { uint64 v; };
    struct Go_locals { uint64 i; sint64 s; uint64 t; };
    PUBLIC_FUNCTION_WITH_LOCALS(Go)
    {
${line}
        output.v = 0;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Go, 1); }
};
`;
    const members = (line: string, marker: string) => {
        const source = body(line);
        return completeMembersAt({ source, offset: source.indexOf(marker) + marker.length, contractName: "Desk", slot: 28 })?.map((item) => item.name);
    };

    expect(members("        locals.t = state.get().alpha;", "state.get().")).toEqual(["alpha", "beta"]);
    expect(members("        locals.s = -state.get().beta;", "-state.get().")).toEqual(["alpha", "beta"]);
    expect(members("        locals.s = (sint64)state.get().alpha;", "state.get().")).toEqual(["alpha", "beta"]);
    expect(members("        for (locals.i = 0; locals.i < (uint64)state.get().alpha; ++locals.i) { locals.t = 1; }", "state.get().")).toEqual([
        "alpha",
        "beta",
    ]);
});

// A statement spread over lines: replacing only the receiver's line leaves `sadd(` above and `1);` below
// paired with nothing, so the spilled lines are blanked to spaces, which keeps every line number intact.
test("a statement spread over several lines still resolves its receiver", () => {
    const source = `using namespace QPI;
struct Desk2 {};
struct Desk : public ContractBase
{
    struct StateData { uint64 alpha; sint64 beta; };
    struct Go_input { uint64 n; }; struct Go_output { uint64 v; };
    struct Go_locals { uint64 i; uint64 t; };
    PUBLIC_FUNCTION_WITH_LOCALS(Go)
    {
        locals.t = sadd(
            state.get().alpha,
            1);
        if (locals.i > 0
            && state.get().alpha > 0) { locals.t = 1; }
        output.v = 0;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Go, 1); }
};
`;
    const at = (marker: string, occurrence = 0) => {
        let index = -1;
        for (let found = 0; found <= occurrence; found++) index = source.indexOf(marker, index + 1);
        return completeMembersAt({ source, offset: index + marker.length, contractName: "Desk", slot: 28 })?.map((item) => item.name);
    };

    expect(at("state.get().")).toEqual(["alpha", "beta"]);
    expect(at("state.get().", 1)).toEqual(["alpha", "beta"]);
});
