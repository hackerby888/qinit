// Minimal repro for F200: QPI::div(INT32_MIN, -1) traps under clang and does not under the
// TypeScript backend. Reduced from corpus/solidity-port/variants/integers/DivQpi__209b.h.
//
// The three rows the script drives are the finding, the width control, and the promotion control:
//   sint32 INT32_MIN / -1   -> clang traps; the TypeScript backend continues
//   sint64 INT64_MIN / -1   -> both trap (so the divergence is width-specific, not QPI::div-specific)
//   sint32 -6 / 2           -> both agree (so ordinary signed division is not implicated)
using namespace QPI;

struct DivOverflow2
{
};

struct DivOverflow : public ContractBase
{
    struct StateData
    {
        sint64 result32;
        sint64 result64;
        uint64 calls;
    };

    struct Div32_input
    {
        sint32 a;
        sint32 b;
    };
    struct Div32_output {};
    struct Div32_locals
    {
        sint32 quotient;
    };

    struct Div64_input
    {
        sint64 a;
        sint64 b;
    };
    struct Div64_output {};
    struct Div64_locals
    {
        sint64 quotient;
    };

    struct Read_input {};
    struct Read_output
    {
        sint64 result32;
        sint64 result64;
        uint64 calls;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Div32)
    {
        locals.quotient = QPI::div(input.a, input.b);
        state.mut().result32 = (sint64)locals.quotient;
        state.mut().calls++;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Div64)
    {
        locals.quotient = QPI::div(input.a, input.b);
        state.mut().result64 = locals.quotient;
        state.mut().calls++;
    }

    PUBLIC_FUNCTION(Read)
    {
        output.result32 = state.get().result32;
        output.result64 = state.get().result64;
        output.calls = state.get().calls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Div32, 1);
        REGISTER_USER_PROCEDURE(Div64, 2);
    }

    INITIALIZE()
    {
        state.mut().result32 = 0;
        state.mut().result64 = 0;
        state.mut().calls = 0;
    }
};
