// Companion contract for the deterministic compiler/runtime parity matrix.
using namespace QPI;

struct QpiDualCallee2 {};

struct QpiDualCallee : public ContractBase
{
    struct StateData
    {
        uint64 value;
        uint64 calls;
        uint64 initialized;
    };

    struct Add_input { uint64 amount; };
    struct Add_output { uint64 value; };
    struct FailAfterWrite_input
    {
        uint64 amount;
        sint64 divisor;
    };
    struct FailAfterWrite_output { sint64 quotient; };
    struct Read_input {};
    struct Read_output
    {
        uint64 value;
        uint64 calls;
        uint64 initialized;
    };
    struct FailRead_input { sint64 divisor; };
    struct FailRead_output { sint64 quotient; };

    INITIALIZE()
    {
        state.mut().value = 7;
        state.mut().initialized = 0x43414C4C45455741ull;
    }

    PUBLIC_PROCEDURE(Add)
    {
        state.mut().value += input.amount;
        state.mut().calls++;
        output.value = state.get().value;
    }

    PUBLIC_PROCEDURE(FailAfterWrite)
    {
        state.mut().value += input.amount;
        state.mut().calls++;
        output.quotient = div<sint64>(INT64_MIN, input.divisor);
    }

    PUBLIC_FUNCTION(Read)
    {
        output.value = state.get().value;
        output.calls = state.get().calls;
        output.initialized = state.get().initialized;
    }

    PUBLIC_FUNCTION(FailRead)
    {
        output.quotient = div<sint64>(INT64_MIN, input.divisor);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Add, 1);
        REGISTER_USER_PROCEDURE(FailAfterWrite, 2);
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_FUNCTION(FailRead, 2);
    }
};
