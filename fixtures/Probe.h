// Context-read fixture: qpi.getEntity (balance), qpi.arbitrator, qpi.queryFeeReserve.
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

    struct Bal_input { id who; };
    struct Bal_output { sint64 incoming; sint64 outgoing; };
    struct Bal_locals { Entity e; };
    struct Info_input {};
    struct Info_output { id arbitrator; sint64 reserve; };

    PUBLIC_FUNCTION_WITH_LOCALS(Bal)
    {
        qpi.getEntity(input.who, locals.e);
        output.incoming = locals.e.incomingAmount;
        output.outgoing = locals.e.outgoingAmount;
    }

    PUBLIC_FUNCTION(Info)
    {
        output.arbitrator = qpi.arbitrator();
        output.reserve = qpi.queryFeeReserve(0);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Bal, 1);
        REGISTER_USER_FUNCTION(Info, 2);
    }

    INITIALIZE()
    {
        state.mut().dummy = 0;
    }
};
