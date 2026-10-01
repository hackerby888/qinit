import { expect, test } from "bun:test";
import { analyzeContract } from "../../src/analyzer";

// F243: QPI's PRIVATE_* macros open `protected:`, so a struct declared after one — until a PUBLIC_* macro reopens `public:` — is a protected
// member. clang refuses another contract that names it ("'Ask_input' is a protected member of 'Leaf'"); the TypeScript build accepted it.
const leaf = (body: string) => `using namespace QPI;
struct Leaf2 {};
struct Leaf : public ContractBase {
    struct StateData { uint64 count; };
${body}
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Ask, 1); }
};
`;
const NOTE = `    struct Note_input {};
    struct Note_output {};
    PRIVATE_PROCEDURE(Note) { }
`;
const ASK = `    struct Ask_input { uint64 value; };
    struct Ask_output { uint64 value; };
    PUBLIC_PROCEDURE(Ask) { output.value = input.value; }
`;
const CALLER = `using namespace QPI;
struct Mid2 {};
struct Mid : public ContractBase {
    struct StateData { uint64 value; };
    struct Run_input {};
    struct Run_output {};
    struct Run_locals { Leaf::Ask_input in; Leaf::Ask_output out; };
    PUBLIC_PROCEDURE_WITH_LOCALS(Run) { locals.in.value = 1; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};
`;

const findings = (calleeBody: string) =>
    analyzeContract({ source: CALLER, contractName: "Mid", slot: 35, calleeSources: [{ name: "Leaf", slot: 34, source: leaf(calleeBody) }] })
        .diagnostics.filter((diagnostic) => diagnostic.code === "qpi/non-public-callee-member")
        .map((diagnostic) => `${diagnostic.span.line}:${diagnostic.span.column} ${diagnostic.message.slice(0, diagnostic.message.indexOf(","))}`);

test("a callee's struct declared after a private procedure is protected to the caller", () => {
    expect(findings(NOTE + ASK)).toEqual([
        "7:31 'Ask_input' is declared after PRIVATE_PROCEDURE(Note) in Leaf",
        "7:51 'Ask_output' is declared after PRIVATE_PROCEDURE(Note) in Leaf",
    ]);
});

test("declared above the private procedure, or reopened by a public macro or label, it is not", () => {
    expect(findings(ASK + NOTE)).toEqual([]);
    expect(findings(NOTE + "    public:\n" + ASK)).toEqual([]);
    expect(findings(NOTE + "    PUBLIC_FUNCTION(Peek) { }\n    struct Peek_input {};\n    struct Peek_output {};\n" + ASK)).toEqual([]);
});

// the callee's body is the top-level definition, not an earlier `struct Leaf` written as a parameter type or nested in another struct
test("the contract body is found past earlier structs that mention its name, and as a class", () => {
    const expected = ["7:31 'Ask_input' is declared after PRIVATE_PROCEDURE(Note) in Leaf", "7:51 'Ask_output' is declared after PRIVATE_PROCEDURE(Note) in Leaf"];
    const before = (prefix: string, head = "struct Leaf : public ContractBase") =>
        analyzeContract({ source: CALLER, contractName: "Mid", slot: 35, calleeSources: [{ name: "Leaf", slot: 34, source: `using namespace QPI;\n${prefix}${head} {\n${NOTE}${ASK}};\n` }] })
            .diagnostics.filter((diagnostic) => diagnostic.code === "qpi/non-public-callee-member")
            .map((diagnostic) => `${diagnostic.span.line}:${diagnostic.span.column} ${diagnostic.message.slice(0, diagnostic.message.indexOf(","))}`);
    expect(before("struct Helper { static void touch(struct Leaf& leaf) { } };\n")).toEqual(expected);
    expect(before("struct Outer { struct Leaf { uint64 x; }; };\n")).toEqual(expected);
    expect(before("struct Leaf;\n")).toEqual(expected);
    expect(before("", "class Leaf : public ContractBase")).toEqual(expected);
    // the Qubic convention names the state struct after the contract, and the include-time name may be the CONTRACT_STATE_TYPE macro
    expect(before("", "struct CONTRACT_STATE_TYPE : public ContractBase")).toEqual(expected);
});

// naming a public struct in a protected region declares nothing, so it stays public; clang accepts the caller.
test("a use of a public struct after a private procedure does not hide it", () => {
    expect(findings(ASK + NOTE + "    struct Ask_input lastAsk;\n")).toEqual([]);
    expect(findings(ASK + NOTE + "    static void touch(struct Ask_input& in) { }\n")).toEqual([]);
    expect(findings(ASK + NOTE + "    struct Ask_input lastAsk{};\n    struct Ask_output* lastOut = nullptr;\n")).toEqual([]);
});

test("a protected typedef is known by its own name, not by a field or an array bound", () => {
    const named = (calleeBody: string, member: string) =>
        analyzeContract({
            source: CALLER.replace("Leaf::Ask_input in; Leaf::Ask_output out;", `Leaf::${member} in;`),
            contractName: "Mid",
            slot: 35,
            calleeSources: [{ name: "Leaf", slot: 34, source: leaf(calleeBody) }],
        })
            .diagnostics.filter((diagnostic) => diagnostic.code === "qpi/non-public-callee-member")
            .map((diagnostic) => diagnostic.message.slice(0, diagnostic.message.indexOf(" is ")));
    const inline = ASK + NOTE + "    typedef struct { uint64 a; } Foo;\n";
    expect(named(inline, "Foo")).toEqual(["'Foo'"]);
    expect(named(inline, "a")).toEqual([]);
    const sized = ASK + NOTE + "    static constexpr uint64 N = 4;\n    typedef uint8 Buf[N];\n";
    expect(named(sized, "Buf")).toEqual(["'Buf'"]);
    expect(named(sized, "N")).toEqual([]);
    expect(named(ASK + NOTE + "    typedef Array<uint8, 8> Bytes;\n", "Bytes")).toEqual(["'Bytes'"]);
});

test("a struct, a derived struct and an enum class defined after a private procedure stay hidden", () => {
    const named = (calleeBody: string, member: string) =>
        analyzeContract({
            source: CALLER.replace("Leaf::Ask_input in; Leaf::Ask_output out;", `Leaf::${member} in;`),
            contractName: "Mid",
            slot: 35,
            calleeSources: [{ name: "Leaf", slot: 34, source: leaf(calleeBody) }],
        }).diagnostics.filter((diagnostic) => diagnostic.code === "qpi/non-public-callee-member").length;
    expect(named(ASK + NOTE + "    struct Extra : public Ask_input { uint64 more; };\n", "Extra")).toBe(1);
    expect(named(ASK + NOTE + "    struct Sealed final { uint64 more; };\n", "Sealed")).toBe(1);
    expect(named(ASK + NOTE + "    enum class Mode : uint8 { A, B };\n", "Mode")).toBe(1);
});

test("an explicit protected: label hides the struct too", () => {
    expect(findings("    protected:\n" + ASK)).toEqual(["7:31 'Ask_input' is declared after protected: in Leaf", "7:51 'Ask_output' is declared after protected: in Leaf"]);
});

// The cross-contract call macros name `Callee::Proc_locals` (and the procedure itself) without the caller writing them; clang refuses there too
// ("'Ask_locals' is a protected member of 'Leaf'" at the INVOKE_OTHER_CONTRACT_PROCEDURE line).
const INVOKER = `using namespace QPI;
struct Mid2 {};
struct Mid : public ContractBase {
    struct StateData { uint64 value; };
    struct Run_input {};
    struct Run_output {};
    struct Run_locals { Leaf::Ask_input in; Leaf::Ask_output out; };
    PUBLIC_PROCEDURE_WITH_LOCALS(Run) { INVOKE_OTHER_CONTRACT_PROCEDURE(Leaf, ENTRY, locals.in, locals.out, 0); }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Run, 1); }
};
`;
const invoking = (calleeBody: string, entry: string) =>
    analyzeContract({
        source: INVOKER.replace("ENTRY", entry),
        contractName: "Mid",
        slot: 35,
        calleeSources: [{ name: "Leaf", slot: 34, source: leaf(calleeBody) }],
    })
        .diagnostics.filter((diagnostic) => diagnostic.code === "qpi/non-public-callee-member")
        .map((diagnostic) => `${diagnostic.span.line}:${diagnostic.span.column} ${diagnostic.message.slice(0, diagnostic.message.indexOf(":"))}`);

test("a call macro reaching a protected _locals is refused at the macro", () => {
    const io = "    struct Ask_input { uint64 value; };\n    struct Ask_output { uint64 value; };\n";
    const rest = "    struct Ask_locals { uint64 scratch; };\n    PUBLIC_PROCEDURE_WITH_LOCALS(Ask) { output.value = input.value; }\n";
    expect(invoking(io + NOTE + rest, "Ask")).toEqual(["8:41 INVOKE_OTHER_CONTRACT_PROCEDURE(Leaf, Ask, …) names Leaf"]);
    expect(invoking(io + rest + NOTE, "Ask")).toEqual([]);
});

test("invoking the callee's private procedure is refused", () => {
    expect(invoking(ASK + NOTE, "Note")).toEqual(["8:41 INVOKE_OTHER_CONTRACT_PROCEDURE(Leaf, Note, …) names Leaf"]);
});
