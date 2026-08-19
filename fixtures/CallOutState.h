// The host, not the contract, writes this state: an inter-contract call's output buffer is a state
// field, so lh_liteCallFunction fills it through an out-pointer no contract store ever touches.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        Counter::Get_output pulled;
    };

    struct Pull_input {};
    struct Pull_output {};
    struct Pull_locals
    {
        Counter::Get_input request;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Pull)
    {
        CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.request, state.mut().pulled);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Pull, 1);
    }
};
