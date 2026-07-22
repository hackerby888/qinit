// Price-oracle fixture shared by the TS/Clang and VirtualNode/WAMR parity tests.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        sint64 numerator;
        sint64 denominator;
        sint64 queryId;
        sint32 subscriptionId;
        uint8 status;
    };

    struct Query_input
    {
        OI::Price::OracleQuery query;
        uint32 timeoutMillisec;
    };
    struct Query_output { sint64 queryId; };
    struct Query_locals {};

    struct Subscribe_input
    {
        OI::Price::OracleQuery query;
        uint32 periodMillisec;
        bit notifyPrevious;
    };
    struct Subscribe_output { sint32 subscriptionId; };
    struct Subscribe_locals {};

    struct Last_input {};
    struct Last_output
    {
        sint64 numerator;
        sint64 denominator;
        sint64 queryId;
        sint32 subscriptionId;
        uint8 status;
    };

    struct Status_input { sint64 queryId; };
    struct Status_output { uint64 status; };

    struct Unsubscribe_input { sint32 subscriptionId; };
    struct Unsubscribe_output { uint32 ok; };

    typedef OracleNotificationInput<OI::Price> OnReply_input;
    typedef NoData OnReply_output;
    struct OnReply_locals {};

    PRIVATE_PROCEDURE_WITH_LOCALS(OnReply)
    {
        state.mut().queryId = input.queryId;
        state.mut().subscriptionId = input.subscriptionId;
        state.mut().status = input.status;
        if (input.status == ORACLE_QUERY_STATUS_SUCCESS && OI::Price::replyIsValid(input.reply))
        {
            state.mut().numerator = input.reply.numerator;
            state.mut().denominator = input.reply.denominator;
        }
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Query)
    {
        output.queryId = QUERY_ORACLE(OI::Price, input.query, OnReply, input.timeoutMillisec);
        state.mut().queryId = output.queryId;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Subscribe)
    {
        output.subscriptionId = SUBSCRIBE_ORACLE(OI::Price, input.query, OnReply, input.periodMillisec, input.notifyPrevious);
        state.mut().subscriptionId = output.subscriptionId;
    }

    PUBLIC_FUNCTION(Last)
    {
        output.numerator = state.get().numerator;
        output.denominator = state.get().denominator;
        output.queryId = state.get().queryId;
        output.subscriptionId = state.get().subscriptionId;
        output.status = state.get().status;
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
};
