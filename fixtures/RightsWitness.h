// Share-rights witness: issues an asset, hands shares to a user, and records the context PRE_RELEASE_SHARES
// runs in (originator, invocator, owner, other contract). allowMode 1 approves only when originator == owner.
using namespace QPI;

struct RightsWitness2
{
};

struct RightsWitness : public ContractBase
{
    struct StateData
    {
        id lastOriginator;
        id lastInvocator;
        id lastOwner;
        uint64 lastOther;
        uint64 releaseCalls;
        uint64 postReleaseCalls;
        uint64 allowMode;
        uint64 lastAllowed;
    };

    struct Issue_input
    {
        uint64 name;
        sint64 shares;
    };
    struct Issue_output { sint64 issued; };
    struct Give_input
    {
        uint64 name;
        id to;
        sint64 shares;
    };
    struct Give_output { sint64 result; };
    struct SetMode_input { uint64 mode; };
    struct SetMode_output { uint64 mode; };
    struct Seen_input {};
    struct Seen_output
    {
        id lastOriginator;
        id lastInvocator;
        id lastOwner;
        uint64 lastOther;
        uint64 releaseCalls;
        uint64 postReleaseCalls;
        uint64 allowMode;
        uint64 lastAllowed;
    };

    PUBLIC_PROCEDURE(Issue)
    {
        output.issued = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
    }

    PUBLIC_PROCEDURE(Give)
    {
        output.result = qpi.transferShareOwnershipAndPossession(input.name, SELF, SELF, SELF, input.shares, input.to);
    }

    PUBLIC_PROCEDURE(SetMode)
    {
        state.mut().allowMode = input.mode;
        output.mode = input.mode;
    }

    PUBLIC_FUNCTION(Seen)
    {
        output.lastOriginator = state.get().lastOriginator;
        output.lastInvocator = state.get().lastInvocator;
        output.lastOwner = state.get().lastOwner;
        output.lastOther = state.get().lastOther;
        output.releaseCalls = state.get().releaseCalls;
        output.postReleaseCalls = state.get().postReleaseCalls;
        output.allowMode = state.get().allowMode;
        output.lastAllowed = state.get().lastAllowed;
    }

    PRE_RELEASE_SHARES()
    {
        state.mut().lastOriginator = qpi.originator();
        state.mut().lastInvocator = qpi.invocator();
        state.mut().lastOwner = input.owner;
        state.mut().lastOther = input.otherContractIndex;
        state.mut().releaseCalls += 1;
        output.allowTransfer = (state.get().allowMode == 0) || (qpi.originator() == input.owner);
        output.requestedFee = 0;
        state.mut().lastAllowed = output.allowTransfer ? 1 : 0;
    }

    POST_RELEASE_SHARES()
    {
        state.mut().postReleaseCalls += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Issue, 1);
        REGISTER_USER_PROCEDURE(Give, 2);
        REGISTER_USER_PROCEDURE(SetMode, 3);
        REGISTER_USER_FUNCTION(Seen, 1);
    }
};
