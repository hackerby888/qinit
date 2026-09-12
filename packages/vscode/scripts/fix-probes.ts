// Sources that should offer a quick fix, each shaped so the fix has somewhere to go wrong: a non-power-of-two
// array size, a division whose operands are not bare names, a stack local carrying an initializer.
export interface FixProbe {
    name: string;
    source: string;
    /** The code this probe expects a fix to be offered for; absence is itself reported. */
    expectFix?: string;
    /** The code whose fix cannot produce compiling source here, so offering one at all is the defect. */
    expectNoFix?: string;
    note: string;
}

function contract(parts: { state?: string; types?: string; body?: string; locals?: string }): string {
    const withLocals = parts.locals !== undefined;
    return `using namespace QPI;

struct FixProbe2
{
};

struct FixProbe : public ContractBase
{
${parts.types ?? ""}
    struct StateData
    {
        uint64 counter;
${parts.state ?? ""}
    };

    struct Go_input {};
    struct Go_output { uint64 value; };
${withLocals ? `    struct Go_locals\n    {\n${parts.locals}\n    };\n` : ""}
    PUBLIC_PROCEDURE${withLocals ? "_WITH_LOCALS" : ""}(Go)
    {
        state.mut().counter += 1;
${parts.body ?? ""}
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Go, 1);
    }
};
`;
}

export const FIX_PROBES: FixProbe[] = [
    // ---- the Array<T, N> fix: N must be a power of two, and the fix copies the size verbatim ----
    {
        name: "array/c-array-pow2",
        source: contract({ state: "        uint64 slots[8];" }),
        expectFix: "qpi/no-brackets",
        note: "8 is a legal Array size, so the fix should produce something that builds",
    },
    {
        name: "array/c-array-non-pow2",
        source: contract({ state: "        uint64 slots[6];" }),
        expectNoFix: "qpi/no-brackets",
        note: "6 is not a power of two — Array<uint64, 6> does not compile, so no fix may be offered",
    },
    {
        name: "array/c-array-size-3",
        source: contract({ state: "        uint64 slots[3];" }),
        expectNoFix: "qpi/no-brackets",
        note: "the smallest interesting non-power-of-two",
    },
    {
        name: "array/c-array-in-locals",
        source: contract({ locals: "        uint64 scratch[6];", body: "        state.mut().counter += 1;" }),
        expectNoFix: "qpi/no-brackets",
        note: "the same shape where a developer most often writes it",
    },
    {
        name: "array/c-array-of-struct",
        source: contract({
            types: "    struct Cell { uint64 qty; };\n",
            state: "        Cell cells[4];",
        }),
        expectFix: "qpi/no-brackets",
        note: "a struct element rather than a scalar",
    },

    // ---- the div/mod fix ----
    {
        name: "divmod/plain-locals",
        source: contract({
            locals: "        uint64 a;\n        uint64 b;",
            body: "        locals.a = locals.a / locals.b;",
        }),
        expectFix: "qpi/no-division",
        note: "the shape the fix was written for",
    },
    {
        name: "divmod/literal-divisor",
        source: contract({ locals: "        uint64 a;", body: "        locals.a = locals.a / 2;" }),
        expectNoFix: "qpi/no-division",
        note: "a bare literal cannot deduce T against a typed dividend, so no fix may be offered",
    },
    {
        name: "divmod/modulo",
        source: contract({ locals: "        uint64 a;\n        uint64 b;", body: "        locals.a = locals.a % locals.b;" }),
        expectFix: "qpi/no-modulo",
        note: "the modulo twin",
    },
    {
        name: "divmod/chained-division",
        source: contract({
            locals: "        uint64 a;\n        uint64 b;\n        uint64 c;",
            body: "        locals.a = locals.a / locals.b / locals.c;",
        }),
        expectFix: "qpi/no-division",
        note: "two divisions on one line — the fix must not mangle the second",
    },
    {
        name: "divmod/mixed-precedence",
        source: contract({
            locals: "        uint64 a;\n        uint64 b;\n        uint64 c;",
            body: "        locals.a = locals.c + locals.a / locals.b;",
        }),
        expectFix: "qpi/no-division",
        note: "an addition beside the division — rewriting must not change what binds to what",
    },

    // ---- the stack-local fix: moving a declaration into a struct that cannot hold an initializer ----
    {
        name: "stacklocal/no-initializer",
        source: contract({ body: "        uint64 scratch;\n        state.mut().counter += scratch;" }),
        expectFix: "qpi/stack-local",
        note: "the clean case the fix was written for",
    },
    {
        name: "stacklocal/with-initializer",
        source: contract({ body: "        uint64 scratch = 3;\n        state.mut().counter += scratch;" }),
        expectFix: "qpi/stack-local",
        note: "an initializer a struct member cannot carry into _locals",
    },
    {
        name: "stacklocal/struct-type",
        source: contract({
            types: "    struct Pair { uint64 a; uint64 b; };\n",
            body: "        Pair pair;\n        state.mut().counter += pair.a;",
        }),
        expectFix: "qpi/stack-local",
        note: "an aggregate rather than a scalar",
    },
];
