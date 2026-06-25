// Source/destination manager fixture for the share custody paths: issues its own asset, approves both
// PRE_RELEASE_SHARES (with a settable fee) and PRE_ACQUIRE_SHARES so another contract can acquire from it or
// release back to it.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        sint64 lastResult;
        sint64 fee;
    };

    struct Issue_input
    {
        uint64 name;
        sint64 shares;
    };
    struct Issue_output { sint64 result; };
    struct SetFee_input { sint64 fee; };
    struct SetFee_output {};

    PUBLIC_PROCEDURE(Issue)
    {
        output.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
        state.mut().lastResult = output.result;
    }

    PUBLIC_PROCEDURE(SetFee)
    {
        state.mut().fee = input.fee;
    }

    PRE_RELEASE_SHARES()
    {
        output.allowTransfer = true; // approve acquisition of management rights from this contract
        output.requestedFee = state.get().fee;
    }

    PRE_ACQUIRE_SHARES()
    {
        output.allowTransfer = true; // approve release of management rights to this contract
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Issue, 1);
        REGISTER_USER_PROCEDURE(SetFee, 2);
    }
};
