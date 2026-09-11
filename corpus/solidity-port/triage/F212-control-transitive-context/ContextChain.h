// Control for F212 — the entry-context check holds one hop out, not just on a direct call.
//
// F212's check reads the context class in parameter 0 and only for calls whose target is a sibling
// entry, so the obvious worry is a violation reached indirectly. This is that shape: a
// PUBLIC_FUNCTION calls a PRIVATE_FUNCTION, which calls a PRIVATE_PROCEDURE that writes state.
//
// Both backends refuse it. The middle function is itself an entry, so the check inspects Mid -> Bump
// and reports it; clang refuses the same conversion. Measured, not assumed — this row exists so the
// claim "the check is narrow" is bounded by evidence rather than repeated from memory.
using namespace QPI;

struct ContextChain2
{
};

struct ContextChain : public ContractBase
{
    struct StateData
    {
        uint64 counter;
        uint64 calls;
    };

    struct Bump_input {};
    struct Bump_output {};

    PRIVATE_PROCEDURE(Bump)
    {
        state.mut().counter++;
    }

    struct Mid_input {};
    struct Mid_output
    {
        uint64 seen;
    };
    struct Mid_locals
    {
        Bump_input bumpInput;
        Bump_output bumpOutput;
    };

    PRIVATE_FUNCTION_WITH_LOCALS(Mid)
    {
        CALL(Bump, locals.bumpInput, locals.bumpOutput);
        output.seen = state.get().counter;
    }

    struct Peek_input {};
    struct Peek_output
    {
        uint64 seen;
    };
    struct Peek_locals
    {
        Mid_input midInput;
        Mid_output midOutput;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Peek)
    {
        CALL(Mid, locals.midInput, locals.midOutput);
        output.seen = locals.midOutput.seen;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Peek, 1);
    }

    INITIALIZE()
    {
        state.mut().counter = 0;
        state.mut().calls = 0;
    }
};
