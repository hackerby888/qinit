// Share management-rights fixture: exercises qpi.acquireShares (a procedure-context custody op) from a wasm
// contract. Issues its own asset, then Acquire calls acquireShares so the wasm->lhost->host path is exercised.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        sint64 lastResult;
    };

    struct Issue_input { uint64 name; sint64 shares; };
    struct Issue_output { sint64 result; };
    struct Acquire_input { uint64 name; id issuer; id holder; sint64 shares; uint16 srcMgmt; sint64 fee; };
    struct Acquire_output { sint64 result; };
    struct Last_input {};
    struct Last_output { sint64 result; };

    struct Acquire_locals { Asset a; };

    PUBLIC_PROCEDURE(Issue)
    {
        output.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
        state.mut().lastResult = output.result;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Acquire)
    {
        locals.a.issuer = input.issuer;
        locals.a.assetName = input.name;
        output.result = qpi.acquireShares(locals.a, input.holder, input.holder, input.shares, input.srcMgmt, input.srcMgmt, input.fee);
        state.mut().lastResult = output.result;
    }

    PUBLIC_FUNCTION(Last)
    {
        output.result = state.get().lastResult;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Issue, 1);
        REGISTER_USER_PROCEDURE(Acquire, 2);
        REGISTER_USER_FUNCTION(Last, 1);
    }

    INITIALIZE()
    {
        state.mut().lastResult = 0;
    }
};
