// Regular-tx fixture: reads an account's spectrum balance via qpi.getEntity (balance = incoming - outgoing).
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 dummy;
    };

    struct Balance_input { id who; };
    struct Balance_output { sint64 balance; };
    struct Balance_locals { Entity e; };

    PUBLIC_FUNCTION_WITH_LOCALS(Balance)
    {
        qpi.getEntity(input.who, locals.e);
        output.balance = locals.e.incomingAmount - locals.e.outgoingAmount;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Balance, 1);
    }
};
