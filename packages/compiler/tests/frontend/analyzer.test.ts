import { DiagnosticSeverity, QpiContextKind, SourceAnalysisOrigin } from "../../src/shared/enums";
import { describe, expect, test } from "bun:test";
import { analyzeContract, detectContractName, type SourceEdit } from "../../src/analyzer";
import { analyzeQpiPolicy } from "../../src/analyzer/source-policy";

function qpiDiagnostics(source: string) {
    return analyzeContract({ source }).diagnostics.filter((item) => item.origin === SourceAnalysisOrigin.QPI);
}

function rules(source: string): Set<string> {
    return new Set(qpiDiagnostics(source).map((item) => item.code));
}

function applyEdits(source: string, edits: SourceEdit[]): string {
    let output = source;
    for (const edit of [...edits].sort((left, right) => right.span.start - left.span.start)) {
        output = output.slice(0, edit.span.start) + edit.newText + output.slice(edit.span.end);
    }
    return output;
}

function procedure(body: string, macro = "PUBLIC_PROCEDURE(Do)"): string {
    return `
using namespace QPI;
struct Contract : public ContractBase {
  struct Do_input {};
  struct Do_output {};
  ${macro} {
    ${body}
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(Do, 1);
  }
};`;
}

test("reports the native QPI source restrictions", () => {
    const cases: Array<[string, string]> = [
        ['auto value = "text";', "qpi/no-string"],
        ["char value = 'x';", "qpi/no-char"],
        ["#define VALUE 1", "qpi/no-preprocessor"],
        ["uint64 value = left / right;", "qpi/no-division"],
        ["uint64 value = left % right;", "qpi/no-modulo"],
        ["uint64 values[4];", "qpi/no-brackets"],
        ["void call(Args... args);", "qpi/no-varargs"],
        ["uint64 __value;", "qpi/no-dunder"],
        ["float value;", "qpi/no-float"],
        ["union Value { uint64 item; };", "qpi/no-union"],
        ["auto value = const_cast<T>(input);", "qpi/no-const-cast"],
        ["QpiContext context;", "qpi/no-qpicontext"],
        ["typedef uint64 Value;", "qpi/no-global-typedef"],
        ["using Value = uint64;", "qpi/no-global-using"],
    ];

    for (const [source, code] of cases) {
        expect(rules(source)).toContain(code);
    }
});

test("ignores comments, static assertions, digit separators, and the qpi.h include", () => {
    const source = `
#include "qpi.h"
// uint64 value = left / right;
/* uint64 values[4]; */
STATIC_ASSERT(A == B, "A / B");
static_assert(sizeof(Value) <= 1024, "small");
uint64 amount = 1'000'000;
using namespace QPI;
`;
    expect(qpiDiagnostics(source)).toEqual([]);
});

test("finds stack locals with nested templates and reports unsafe declarations without fixes", () => {
    const source = procedure(`
HashMap<id, Array<uint64, 2>, 8> values;
uint64 first, second;
for (uint64 index = 0; index < 4; index = index + 1) {}
`);
    const locals = qpiDiagnostics(source).filter((item) => item.code === "qpi/stack-local");

    expect(locals.map((item) => item.message.match(/`(\w+)`/)?.[1])).toEqual(["values", "first", "second", "index"]);
    expect(locals.find((item) => item.message.includes("values"))?.fixes).toHaveLength(1);
    expect(locals.find((item) => item.message.includes("first"))?.fixes).toBeUndefined();
    expect(locals.find((item) => item.message.includes("index"))?.fixes).toBeUndefined();
});

test("moves an unambiguous local into the function locals struct", () => {
    const source = procedure(`
uint64 amount = input.amount;
state.mut().total = amount;
`);
    const finding = qpiDiagnostics(source).find((item) => item.code === "qpi/stack-local");
    expect(finding?.fixes).toHaveLength(1);

    const output = applyEdits(source, finding!.fixes![0].edits);
    expect(output).toContain("struct Do_locals { uint64 amount; };");
    expect(output).toContain("PUBLIC_PROCEDURE_WITH_LOCALS(Do)");
    expect(output).toContain("locals.amount = input.amount;");
    expect(output).toContain("state.mut().total = locals.amount;");
    expect(qpiDiagnostics(output).filter((item) => item.code === "qpi/stack-local" || item.code === "qpi/needs-with-locals")).toEqual([]);
});

test("recognizes shareholder system procedures when checking locals forms", () => {
    for (const name of ["SET_SHAREHOLDER_PROPOSAL", "SET_SHAREHOLDER_VOTES"]) {
        const diagnostics = analyzeQpiPolicy(`
struct ${name}_locals { uint64 value; };
${name}() { locals.value = 1; }
`);

        expect(diagnostics.map((item) => item.code)).toContain("qpi/needs-with-locals");
    }
});

test("returns neutral array and safe-math source edits", () => {
    const source = `
struct Contract : public ContractBase {
  struct StateData {
    uint64 values[4];
  };
  PUBLIC_FUNCTION(Read) { output.value = input.left / input.right; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;
    const diagnostics = qpiDiagnostics(source);
    const array = diagnostics.find((item) => item.code === "qpi/no-brackets");
    const division = diagnostics.find((item) => item.code === "qpi/no-division");

    expect(array?.fixes?.[0].title).toBe("Convert to Array<T, N>");
    expect(division?.fixes?.[0].title).toBe("Convert to div(a, b)");
    expect(applyEdits(source, division!.fixes![0].edits)).toContain("div(input.left, input.right)");
});

test("reports registration and public interface mistakes", () => {
    const source = `
struct Contract : public ContractBase {
  struct Read_input {};
  struct Read_output { Collection<id, 8> values; };
  struct Other_input {};
  struct Other_output {};
  PUBLIC_FUNCTION(Read) {}
  PUBLIC_FUNCTION(Other) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
    REGISTER_USER_FUNCTION(Other, 1);
  }
};`;
    const codes = rules(source);
    expect(codes).toContain("qpi/dup-fn-index");
    expect(codes).toContain("qpi/public-complex-type");
});

test("reports forbidden public interface aliases", () => {
    const source = `
using namespace QPI;
struct Contract : public ContractBase {
  typedef NoData Read_input;
  typedef HashMap<uint64, uint64, 4> Read_output;
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

    const diagnostics = analyzeContract({ source }).diagnostics;
    expect(diagnostics.some((item) => item.message.includes("HashMap is forbidden") && item.message.includes("Read_output"))).toBe(true);
});

test("rejects direct and nested LinkedList inputs and outputs", () => {
    const source = `
using namespace QPI;
struct Contract : public ContractBase {
  struct Wrapped { LinkedList<uint16, 8> values; };
  typedef LinkedList<uint64, 8> Read_input;
  typedef Array<Wrapped, 2> Read_output;
  typedef Wrapped Write_input;
  using Write_output = LinkedList<uint16, 8>;
  PUBLIC_FUNCTION(Read) {}
  PUBLIC_PROCEDURE(Write) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
    REGISTER_USER_PROCEDURE(Write, 2);
  }
};`;

    const messages = analyzeContract({ source })
        .diagnostics.map((item) => item.message)
        .filter((message) => message.includes("LinkedList"));

    for (const interfaceName of ["Read_input", "Read_output", "Write_input", "Write_output"]) {
        expect(messages.some((message) => message.includes("LinkedList") && message.includes(interfaceName))).toBe(true);
    }
});

test("allows direct and nested BitArray public types", () => {
    const source = `
using namespace QPI;
struct Contract : public ContractBase {
  typedef BitArray<128> Read_input;
  typedef Array<BitArray<64>, 2> Read_output;
  PUBLIC_FUNCTION(Read) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Read, 1);
  }
};`;

    expect(analyzeContract({ source }).diagnostics.some((item) => item.code === "qpi/public-complex-type")).toBe(false);
});

test("includes compiler semantic diagnostics without changing the QPI policy", () => {
    const source = procedure("const uint64 value = 1; value = 2;");
    const diagnostics = analyzeContract({ source }).diagnostics;

    expect(
        diagnostics.some(
            (item) => item.origin === SourceAnalysisOrigin.COMPILER && item.code === "compiler/semantic" && item.message.includes("cannot assign to const"),
        ),
    ).toBe(true);
    expect(diagnostics.some((item) => item.code === "qpi/stack-local")).toBe(true);
});

test("keeps diagnostics in bounds for incomplete source", () => {
    const source = "struct Contract : public ContractBase { PUBLIC_PROCEDURE(";
    const result = analyzeContract({ source });

    for (const item of result.diagnostics) {
        expect(item.span.start).toBeGreaterThanOrEqual(0);
        expect(item.span.end).toBeGreaterThanOrEqual(item.span.start);
        expect(item.span.end).toBeLessThanOrEqual(source.length);
    }
});

test("detects standalone contract names without comments or strings", () => {
    expect(detectContractName("struct Counter : public ContractBase {}")).toBe("Counter");
    expect(detectContractName("// struct Fake : ContractBase {}\nstruct Plain {};")).toBeUndefined();
    expect(detectContractName('const char* text = "struct Fake : ContractBase";')).toBeUndefined();
});

test("reports active inter-contract calls in source order", () => {
    const source = `
struct Caller : public ContractBase {
  struct StateData {};
  PUBLIC_PROCEDURE(run) {
    // CALL_OTHER_CONTRACT_FUNCTION(Commented, Get, input, output);
    const char* text = "INVOKE_OTHER_CONTRACT_PROCEDURE(String, Set, i, o, 0)";
#if 0
    CALL_OTHER_CONTRACT_FUNCTION(Disabled, Get, input, output);
#endif
    CALL_OTHER_CONTRACT_FUNCTION(Target, Get, input, output);
    INVOKE_OTHER_CONTRACT_PROCEDURE_E(Target, Set, input, output, 0, error);
  }
};
`;

    const result = analyzeContract({ source, contractName: "Caller", slot: 1 });

    expect(
        result.calls.map(({ kind, callee, entry }) => ({
            kind,
            callee,
            entry,
        })),
    ).toEqual([
        {
            kind: QpiContextKind.FUNCTION,
            callee: "Target",
            entry: "Get",
        },
        {
            kind: QpiContextKind.PROCEDURE,
            callee: "Target",
            entry: "Set",
        },
    ]);
    expect(result.calls.map((call) => source.slice(call.span.start, call.span.end))).toEqual([
        "CALL_OTHER_CONTRACT_FUNCTION(Target, Get, input, output)",
        "INVOKE_OTHER_CONTRACT_PROCEDURE_E(Target, Set, input, output, 0, error)",
    ]);
});

describe("LOG_* payload validation", () => {
    const LOGGING_SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct LogMessage { uint32 _contractIndex; uint32 _type; uint64 value; sint8 _terminator; };
  struct StateData { uint32 calls; };
  struct Emit_input { uint64 value; }; struct Emit_output {};
  struct Emit_locals { LogMessage message; };
  PUBLIC_PROCEDURE_WITH_LOCALS(Emit) {
    LOG_INFO(locals.message);
    state.mut().calls += 1;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Emit, 1); }
};`;

    // The LOG_INFO call sits on line 9 of the raw source. Asserting it proves the span was remapped
    // back from preprocessed coordinates rather than reported in them.
    const LOG_CALL_LINE = 9;

    function compilerDiagnostics(source: string) {
        return analyzeContract({ source }).diagnostics.filter((item) => item.origin === SourceAnalysisOrigin.COMPILER);
    }

    test("a well-formed payload produces no compiler diagnostics", () => {
        expect(compilerDiagnostics(LOGGING_SOURCE)).toEqual([]);
    });

    test("a payload struct without _terminator is reported at the call", () => {
        const source = LOGGING_SOURCE.replace("sint8 _terminator;", "sint8 end;");
        const findings = compilerDiagnostics(source);

        expect(findings.map((item) => item.message)).toEqual(["__qinit_log_info payload struct must contain _terminator"]);
        expect(findings[0].severity).toBe(DiagnosticSeverity.ERROR);
        expect(findings[0].span.line).toBe(LOG_CALL_LINE);
    });

    test("a _terminator below the minimum offset is reported", () => {
        const source = LOGGING_SOURCE.replace("uint32 _contractIndex; uint32 _type; uint64 value; sint8 _terminator;", "uint32 value; sint8 _terminator;");
        const findings = compilerDiagnostics(source);

        expect(findings.map((item) => item.message)).toEqual(["__qinit_log_info payload _terminator offset must be at least 8 bytes"]);
        expect(findings[0].span.line).toBe(LOG_CALL_LINE);
    });

    test("a scalar payload is reported as a non-struct", () => {
        const source = LOGGING_SOURCE.replace("LOG_INFO(locals.message);", "LOG_INFO(input.value);");

        expect(compilerDiagnostics(source).map((item) => item.message)).toEqual(["__qinit_log_info payload must be a struct"]);
    });

    test("an unresolvable payload stays silent rather than guessing", () => {
        const source = "struct X : public ContractBase { PUBLIC_PROCEDURE(Do) { LOG_INFO(locals.msg); } };";

        expect(compilerDiagnostics(source)).toEqual([]);
    });

    // The host overwrites the first four bytes with the contract index, so a wider field there loses
    // them. Reported as a fidelity finding, which the compile driver promotes to an error.
    test("a payload whose leading field spans the reserved word is reported", () => {
        const source = LOGGING_SOURCE.replace("uint32 _contractIndex; uint32 _type;", "uint64 counter;");
        const findings = compilerDiagnostics(source);

        expect(findings.map((item) => item.message)).toEqual(["__qinit_log_info payload must open with a 4-byte word reserved for the contract index"]);
        expect(findings[0].severity).toBe(DiagnosticSeverity.WARNING);
        expect(findings[0].code).toBe("compiler/fidelity");
        expect(findings[0].span.line).toBe(LOG_CALL_LINE);
    });

    test("the reserved word may be named anything four bytes wide", () => {
        const source = LOGGING_SOURCE.replace("uint32 _contractIndex;", "uint32 contractId;");

        expect(compilerDiagnostics(source)).toEqual([]);
    });
});

describe("LOG_* call context", () => {
    const UNREACHABLE = "__qinit_log_info is not available in a function; " + "logs are paired with a transaction";

    // Each case swaps one entry body into the same contract so only the log's context differs.
    function contractLogging(entries: string): string {
        return `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct LogMsg { uint32 _contractIndex; uint32 _type; uint64 value; sint8 _terminator; };
  struct StateData { uint32 calls; };
  struct Peek_input {}; struct Peek_output { uint64 n; };
  struct Peek_locals { LogMsg message; };
  struct Emit_input {}; struct Emit_output {};
  struct Emit_locals { LogMsg message; };
  struct helper_input {}; struct helper_output {};
  struct helper_locals { LogMsg message; };
  struct OldStateData { uint64 previous; };
  struct MIGRATE_locals { LogMsg message; };
  struct END_TICK_locals { LogMsg message; };
  ${entries}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Peek, 1);
    REGISTER_USER_PROCEDURE(Emit, 1);
  }
};`;
    }

    const QUIET_ENTRIES = `PUBLIC_FUNCTION_WITH_LOCALS(Peek) { output.n = 1; }
  PUBLIC_PROCEDURE_WITH_LOCALS(Emit) {}`;

    function compilerMessages(entries: string): string[] {
        return analyzeContract({ source: contractLogging(entries) })
            .diagnostics.filter((item) => item.origin === SourceAnalysisOrigin.COMPILER)
            .map((item) => item.message);
    }

    test("a log in a public function is rejected", () => {
        expect(
            compilerMessages(
                `PUBLIC_FUNCTION_WITH_LOCALS(Peek) { LOG_INFO(locals.message); output.n = 1; }
  PUBLIC_PROCEDURE_WITH_LOCALS(Emit) {}`,
            ),
        ).toEqual([UNREACHABLE]);
    });

    test("a log in a private function is rejected", () => {
        expect(
            compilerMessages(
                `${QUIET_ENTRIES}
  PRIVATE_FUNCTION_WITH_LOCALS(helper) { LOG_INFO(locals.message); }`,
            ),
        ).toEqual([UNREACHABLE]);
    });

    test("a log in a procedure is allowed", () => {
        expect(
            compilerMessages(
                `PUBLIC_FUNCTION_WITH_LOCALS(Peek) { output.n = 1; }
  PUBLIC_PROCEDURE_WITH_LOCALS(Emit) { LOG_INFO(locals.message); }`,
            ),
        ).toEqual([]);
    });

    // Lifecycle hooks run inside tick processing, so their logs are recorded despite MIGRATE
    // sharing the function context type.
    test("logs in lifecycle hooks are allowed", () => {
        expect(
            compilerMessages(
                `${QUIET_ENTRIES}
  END_TICK_WITH_LOCALS() { LOG_INFO(locals.message); }`,
            ),
        ).toEqual([]);
        expect(
            compilerMessages(
                `${QUIET_ENTRIES}
  MIGRATE_WITH_LOCALS() { LOG_INFO(locals.message); }`,
            ),
        ).toEqual([]);
    });
});
