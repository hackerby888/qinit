// Witnesses whether a failed QUERY_ORACLE runs its notification before returning, on both engines.
using namespace QPI;

struct OracleInline2
{
};

struct OracleInline : public ContractBase
{
    struct StateData
    {
        uint64 notifications;
        uint64 seenInsideCall;
        sint64 queryId;
        sint32 subscriptionId;
        uint8 status;
    };

    typedef OracleNotificationInput<OI::Price> OnReply_input;
    typedef NoData OnReply_output;
    struct OnReply_locals
    {
    };

    PRIVATE_PROCEDURE_WITH_LOCALS(OnReply)
    {
        state.mut().notifications++;
        state.mut().queryId = input.queryId;
        state.mut().subscriptionId = input.subscriptionId;
        state.mut().status = input.status;
    }

    struct Query_input
    {
        OI::Price::OracleQuery query;
        uint32 timeoutMillisec;
    };
    struct Query_output
    {
        sint64 queryId;
        uint64 notificationsAfter;
        uint64 seenInsideCall;
    };
    struct Query_locals
    {
        uint64 before;
    };

    // reads its own state straight after the query, so a notification that ran inside the call is visible here.
    PUBLIC_PROCEDURE_WITH_LOCALS(Query)
    {
        locals.before = state.get().notifications;
        output.queryId = QUERY_ORACLE(OI::Price, input.query, OnReply, input.timeoutMillisec);
        output.notificationsAfter = state.get().notifications;
        output.seenInsideCall = (state.get().notifications > locals.before) ? 1 : 0;
        state.mut().seenInsideCall = output.seenInsideCall;
    }

    struct Last_input
    {
    };
    struct Last_output
    {
        uint64 notifications;
        uint64 seenInsideCall;
        sint64 queryId;
        sint32 subscriptionId;
        uint8 status;
    };

    PUBLIC_FUNCTION(Last)
    {
        output.notifications = state.get().notifications;
        output.seenInsideCall = state.get().seenInsideCall;
        output.queryId = state.get().queryId;
        output.subscriptionId = state.get().subscriptionId;
        output.status = state.get().status;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE_NOTIFICATION(OnReply);
        REGISTER_USER_PROCEDURE(Query, 2);
        REGISTER_USER_FUNCTION(Last, 1);
    }
};
