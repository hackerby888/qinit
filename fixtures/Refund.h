using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 pokes; // Poke invocations, to prove the procedure still runs after the callback refunded
    };

    struct Poke_input {};
    struct Poke_output {};
    struct Get_input {};
    struct Get_output
    {
        uint64 pokes;
    };

    PUBLIC_PROCEDURE(Poke)
    {
        state.mut().pokes += 1;
    }

    PUBLIC_FUNCTION(Get)
    {
        output.pokes = state.get().pokes;
    }

    POST_INCOMING_TRANSFER()
    {
        qpi.transfer(input.sourceId, input.amount);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Poke, 1);
        REGISTER_USER_FUNCTION(Get, 1);
    }
};
