// Fault fixture: an abort in a function, an abort in a procedure, and a genuine Wasm trap (signed
// division overflow), so every failure class has its own entry and a passing control input.
using namespace QPI;

struct FaultZoo2
{
};

struct FaultZoo : public ContractBase
{
    struct StateData
    {
        uint64 calls;
    };

    struct AssertFn_input { uint64 n; };
    struct AssertFn_output { uint64 n; };
    struct Assert_input { uint64 n; };
    struct Assert_output { uint64 n; };
    struct Overflow_input { sint64 divisor; };
    struct Overflow_output { sint64 quotient; };
    struct Calls_input {};
    struct Calls_output { uint64 calls; };

    PUBLIC_FUNCTION(AssertFn)
    {
        CC_ASSERT(input.n < 10);
        output.n = input.n;
    }

    PUBLIC_PROCEDURE(Assert)
    {
        state.mut().calls += 1;
        CC_ASSERT(input.n < 10);
        output.n = input.n;
    }

    PUBLIC_PROCEDURE(Overflow)
    {
        state.mut().calls += 1;
        output.quotient = div<sint64>(INT64_MIN, input.divisor);
    }

    PUBLIC_FUNCTION(Calls)
    {
        output.calls = state.get().calls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(AssertFn, 1);
        REGISTER_USER_FUNCTION(Calls, 2);
        REGISTER_USER_PROCEDURE(Assert, 1);
        REGISTER_USER_PROCEDURE(Overflow, 2);
    }
};
