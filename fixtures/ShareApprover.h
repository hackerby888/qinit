// Source-manager fixture for the share custody approve path: issues its own asset (managed by SELF) and
// implements PRE_RELEASE_SHARES to approve another contract acquiring management rights of those shares.
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

    PUBLIC_PROCEDURE(Issue)
    {
        output.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
        state.mut().lastResult = output.result;
    }

    PRE_RELEASE_SHARES()
    {
        output.allowTransfer = true; // approve any acquisition of management rights from this contract
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Issue, 1);
    }

    INITIALIZE()
    {
        state.mut().lastResult = 0;
    }
};
