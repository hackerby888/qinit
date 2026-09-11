using namespace QPI;

struct Desk2
{
};

// Caller for the completion campaign. Every line below is a receiver the suite completes at: locals and
// its field hops into the callee's structs, state on both the read and write path, qpi, and output.
struct Desk : public ContractBase
{
    struct StateData
    {
        uint64 calls;
        Array<uint64, 4> recent;
    };

    struct Read_input
    {
    };
    struct Read_output
    {
        uint64 value;
    };
    struct Read_locals
    {
        Vault::Get_input input;
        Vault::Get_output output;
    };

    struct Touch_input
    {
    };
    struct Touch_output
    {
    };
    struct Touch_locals
    {
        sint64 reward;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Read)
    {
        locals.input.history.setAll(0);
        locals.input.detail.rank = 0;
        locals.input.detail.bits.setAll(0);
        locals.input.offset = 0;
        CALL_OTHER_CONTRACT_FUNCTION(Vault, Get, locals.input, locals.output);
        output.value = locals.output.value + state.get().calls;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Touch)
    {
        locals.reward = qpi.invocationReward();
        state.mut().calls = state.get().calls + 1;
        state.mut().recent.setAll(0);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Touch, 1);
    }
};
