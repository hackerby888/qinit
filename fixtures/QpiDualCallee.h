// Companion contract for the deterministic compiler/runtime parity matrix.
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 value;
        uint64 calls;
        uint64 initialized;
    };

    struct Add_input { uint64 amount; };
    struct Add_output { uint64 value; };
    struct Read_input {};
    struct Read_output
    {
        uint64 value;
        uint64 calls;
        uint64 initialized;
    };

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

    PUBLIC_FUNCTION(Read)
    {
        output.value = state.get().value;
        output.calls = state.get().calls;
        output.initialized = state.get().initialized;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Add, 1);
        REGISTER_USER_FUNCTION(Read, 1);
    }
};
