// Oracle fixture: queries / subscribes to the Mock oracle interface (value -> {echoed, doubled}) and stores the
// reply delivered to its notification procedure. Exercises the wasm oracle binding end to end.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        sint64 lastReply;
    };

    struct Query_input { uint64 value; uint32 timeoutMillisec; };
    struct Query_output { sint64 queryId; };
    struct Query_locals { OI::Mock::OracleQuery q; };

    struct Subscribe_input { uint64 value; uint32 periodMillisec; };
    struct Subscribe_output { sint64 subscriptionId; };
    struct Subscribe_locals { OI::Mock::OracleQuery q; };

    struct Last_input {};
    struct Last_output { sint64 reply; };

    struct Status_input { sint64 queryId; };
    struct Status_output { uint64 status; };

    struct Unsubscribe_input { sint32 subscriptionId; };
    struct Unsubscribe_output { uint32 ok; };

    typedef OracleNotificationInput<OI::Mock> OnReply_input;
    typedef NoData OnReply_output;
    struct OnReply_locals {};

    PRIVATE_PROCEDURE_WITH_LOCALS(OnReply)
    {
        if (input.status == ORACLE_QUERY_STATUS_SUCCESS)
        {
            state.mut().lastReply = (sint64)input.reply.doubledValue;
        }
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Query)
    {
        locals.q.value = input.value;
        output.queryId = QUERY_ORACLE(OI::Mock, locals.q, OnReply, input.timeoutMillisec);
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Subscribe)
    {
        locals.q.value = input.value;
        output.subscriptionId = SUBSCRIBE_ORACLE(OI::Mock, locals.q, OnReply, input.periodMillisec, true);
    }

    PUBLIC_FUNCTION(Last)
    {
        output.reply = state.get().lastReply;
    }

    PUBLIC_FUNCTION(Status)
    {
        output.status = qpi.getOracleQueryStatus(input.queryId);
    }

    PUBLIC_PROCEDURE(Unsubscribe)
    {
        output.ok = qpi.unsubscribeOracle(input.subscriptionId) ? 1 : 0;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE_NOTIFICATION(OnReply);
        REGISTER_USER_PROCEDURE(Query, 2);
        REGISTER_USER_PROCEDURE(Subscribe, 3);
        REGISTER_USER_PROCEDURE(Unsubscribe, 4);
        REGISTER_USER_FUNCTION(Last, 1);
        REGISTER_USER_FUNCTION(Status, 2);
    }

    INITIALIZE()
    {
        state.mut().lastReply = 0;
    }
};
