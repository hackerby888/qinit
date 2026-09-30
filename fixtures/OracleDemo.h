// asks the price oracle once or by subscription, and counts what its notification procedure is told.
using namespace QPI;

struct OracleDemo2
{
};

struct OracleDemo : public ContractBase
{
    struct StateData
    {
        sint64 lastNumerator;
        sint64 lastDenominator;
        sint64 lastQueryId;
        sint64 askedQueryId;
        sint64 lastInsideCallQueryId;
        sint32 lastSubscriptionId;
        sint32 subscriptionId;
        uint64 notifications;
        uint64 successes;
        uint64 timeouts;
        uint64 unresolvables;
        uint64 unknowns;
        uint64 subscriptionNotifications;
        uint64 notificationsInsideCall;
        sint32 lastSubscribeResult;
        uint8 lastStatus;
        uint8 lastUnsubscribeOk;
        uint8 inCall;
    };

    struct Ask_input { uint32 timeoutMillisec; };
    struct Ask_output { sint64 queryId; };
    struct Ask_locals { OI::Price::OracleQuery query; };

    PUBLIC_PROCEDURE_WITH_LOCALS(Ask)
    {
        locals.query.oracle = OI::Price::getMockOracleId();
        {
            using namespace Ch;
            locals.query.currency1 = id(Q, U, B, I, C);
            locals.query.currency2 = id(U, S, D, T, null);
        }
        locals.query.timestamp = qpi.now();

        state.mut().inCall = 1;
        output.queryId = QUERY_ORACLE(OI::Price, locals.query, OnPrice, input.timeoutMillisec);
        state.mut().inCall = 0;
        state.mut().askedQueryId = output.queryId;
    }

    struct Subscribe_input { uint32 periodMillisec; bit notifyPrevious; };
    struct Subscribe_output { sint32 subscriptionId; };
    struct Subscribe_locals { OI::Price::OracleQuery query; };

    PUBLIC_PROCEDURE_WITH_LOCALS(Subscribe)
    {
        locals.query.oracle = OI::Price::getMockOracleId();
        {
            using namespace Ch;
            locals.query.currency1 = id(Q, U, B, I, C);
            locals.query.currency2 = id(U, S, D, T, null);
        }
        locals.query.timestamp = qpi.now();

        state.mut().inCall = 1;
        output.subscriptionId = SUBSCRIBE_ORACLE(OI::Price, locals.query, OnPrice, input.periodMillisec, input.notifyPrevious);
        state.mut().inCall = 0;
        state.mut().lastSubscribeResult = output.subscriptionId;
        // a refused call must not cost the id of the subscription the contract has
        if (output.subscriptionId >= 0)
        {
            state.mut().subscriptionId = output.subscriptionId;
        }
    }

    struct Unsubscribe_input {};
    struct Unsubscribe_output { uint32 ok; };

    PUBLIC_PROCEDURE(Unsubscribe)
    {
        output.ok = qpi.unsubscribeOracle(state.get().subscriptionId) ? 1 : 0;
        state.mut().lastUnsubscribeOk = output.ok;
        if (output.ok)
        {
            state.mut().subscriptionId = -1;
        }
    }

    // takes the amount sent with it, which pays the oracle fees
    struct Fund_input {};
    struct Fund_output {};

    PUBLIC_PROCEDURE(Fund)
    {
    }

    struct Get_input {};
    struct Get_output
    {
        sint64 lastNumerator;
        sint64 lastDenominator;
        sint64 lastQueryId;
        sint64 askedQueryId;
        sint64 lastInsideCallQueryId;
        sint32 lastSubscriptionId;
        sint32 subscriptionId;
        uint64 notifications;
        uint64 successes;
        uint64 timeouts;
        uint64 unresolvables;
        uint64 unknowns;
        uint64 subscriptionNotifications;
        uint64 notificationsInsideCall;
        sint32 lastSubscribeResult;
        uint8 lastStatus;
        uint8 lastUnsubscribeOk;
        uint8 inCall;
    };

    PUBLIC_FUNCTION(Get)
    {
        output.lastNumerator = state.get().lastNumerator;
        output.lastDenominator = state.get().lastDenominator;
        output.lastQueryId = state.get().lastQueryId;
        output.askedQueryId = state.get().askedQueryId;
        output.lastInsideCallQueryId = state.get().lastInsideCallQueryId;
        output.lastSubscriptionId = state.get().lastSubscriptionId;
        output.subscriptionId = state.get().subscriptionId;
        output.notifications = state.get().notifications;
        output.successes = state.get().successes;
        output.timeouts = state.get().timeouts;
        output.unresolvables = state.get().unresolvables;
        output.unknowns = state.get().unknowns;
        output.subscriptionNotifications = state.get().subscriptionNotifications;
        output.notificationsInsideCall = state.get().notificationsInsideCall;
        output.lastSubscribeResult = state.get().lastSubscribeResult;
        output.lastStatus = state.get().lastStatus;
        output.lastUnsubscribeOk = state.get().lastUnsubscribeOk;
        output.inCall = state.get().inCall;
    }

    struct Status_input { sint64 queryId; };
    struct Status_output { uint64 status; };

    PUBLIC_FUNCTION(Status)
    {
        output.status = qpi.getOracleQueryStatus(input.queryId);
    }

    typedef OracleNotificationInput<OI::Price> OnPrice_input;
    typedef NoData OnPrice_output;
    struct OnPrice_locals {};

    PRIVATE_PROCEDURE_WITH_LOCALS(OnPrice)
    {
        state.mut().notifications = state.get().notifications + 1;
        // set while Ask or Subscribe is running: a notification that comes then came before the call returned
        if (state.get().inCall)
        {
            state.mut().notificationsInsideCall = state.get().notificationsInsideCall + 1;
            state.mut().lastInsideCallQueryId = input.queryId;
        }
        state.mut().lastQueryId = input.queryId;
        state.mut().lastSubscriptionId = input.subscriptionId;
        state.mut().lastStatus = input.status;
        if (input.subscriptionId >= 0)
        {
            state.mut().subscriptionNotifications = state.get().subscriptionNotifications + 1;
        }

        if (input.status == ORACLE_QUERY_STATUS_SUCCESS)
        {
            state.mut().successes = state.get().successes + 1;
            if (OI::Price::replyIsValid(input.reply))
            {
                state.mut().lastNumerator = input.reply.numerator;
                state.mut().lastDenominator = input.reply.denominator;
            }
        }
        else if (input.status == ORACLE_QUERY_STATUS_TIMEOUT)
        {
            state.mut().timeouts = state.get().timeouts + 1;
        }
        else if (input.status == ORACLE_QUERY_STATUS_UNRESOLVABLE)
        {
            state.mut().unresolvables = state.get().unresolvables + 1;
        }
        else
        {
            state.mut().unknowns = state.get().unknowns + 1;
        }
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE_NOTIFICATION(OnPrice);
        REGISTER_USER_PROCEDURE(Ask, 1);
        REGISTER_USER_PROCEDURE(Subscribe, 2);
        REGISTER_USER_PROCEDURE(Unsubscribe, 3);
        REGISTER_USER_PROCEDURE(Fund, 4);
        REGISTER_USER_FUNCTION(Get, 1);
        REGISTER_USER_FUNCTION(Status, 2);
    }

    INITIALIZE()
    {
        state.mut().subscriptionId = -1;
        state.mut().lastSubscriptionId = -1;
        state.mut().askedQueryId = -1;
    }
};
