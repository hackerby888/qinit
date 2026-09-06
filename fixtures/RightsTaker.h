// Share-rights taker: pulls the management rights of the caller's shares in from another contract.
using namespace QPI;

struct RightsTaker2
{
};

struct RightsTaker : public ContractBase
{
    struct StateData
    {
        sint64 lastResult;
    };

    struct Take_input
    {
        uint64 name;
        id issuer;
        sint64 shares;
        uint64 fromContract;
    };
    struct Take_output { sint64 result; };
    struct Last_input {};
    struct Last_output { sint64 result; };

    struct Take_locals { Asset a; };

    PUBLIC_PROCEDURE_WITH_LOCALS(Take)
    {
        locals.a.issuer = input.issuer;
        locals.a.assetName = input.name;
        output.result = qpi.acquireShares(
            locals.a,
            qpi.invocator(),
            qpi.invocator(),
            input.shares,
            (uint16)input.fromContract,
            (uint16)input.fromContract,
            0);
        state.mut().lastResult = output.result;
    }

    PUBLIC_FUNCTION(Last)
    {
        output.result = state.get().lastResult;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Take, 1);
        REGISTER_USER_FUNCTION(Last, 1);
    }
};
