// Asset-op fixture: issueAsset / isAssetIssued / numberOfShares / transferShareOwnershipAndPossession
// / numberOfPossessedShares, plus nextId. The contract issues its own asset (issuer = SELF) and can
// move shares to another id.
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

    struct Issue_input
    {
        uint64 name;
        sint64 shares;
    };
    struct Issue_output { sint64 result; };
    struct Total_input { uint64 name; };
    struct Total_output { sint64 shares; };
    struct Issued_input { uint64 name; };
    struct Issued_output { sint64 issued; };
    struct Move_input
    {
        uint64 name;
        id to;
        sint64 shares;
    };
    struct Move_output { sint64 result; };
    struct Possessed_input
    {
        uint64 name;
        id who;
    };
    struct Possessed_output { sint64 shares; };
    struct NextId_input { id cur; };
    struct NextId_output { id next; };
    struct Last_input {};
    struct Last_output { sint64 result; };

    struct Total_locals { Asset a; };   // QPI: no stack locals in a fn body — use the _locals struct

    PUBLIC_PROCEDURE(Issue)
    {
        output.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
        state.mut().lastResult = output.result;
    }

    PUBLIC_PROCEDURE(Move)
    {
        output.result = qpi.transferShareOwnershipAndPossession(input.name, SELF, SELF, SELF, input.shares, input.to);
        state.mut().lastResult = output.result;
    }

    PUBLIC_FUNCTION_WITH_LOCALS(Total)
    {
        locals.a.issuer = SELF;
        locals.a.assetName = input.name;
        output.shares = qpi.numberOfShares(locals.a, AssetOwnershipSelect::any(), AssetPossessionSelect::any());
    }

    PUBLIC_FUNCTION(Issued)
    {
        output.issued = qpi.isAssetIssued(SELF, input.name) ? 1 : 0;
    }

    PUBLIC_FUNCTION(Possessed)
    {
        output.shares = qpi.numberOfPossessedShares(input.name, SELF, input.who, input.who, SELF_INDEX, SELF_INDEX);
    }

    PUBLIC_FUNCTION(NextId)
    {
        output.next = qpi.nextId(input.cur);
    }

    PUBLIC_FUNCTION(Last)
    {
        output.result = state.get().lastResult;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Issue, 1);
        REGISTER_USER_PROCEDURE(Move, 2);
        REGISTER_USER_FUNCTION(Total, 1);
        REGISTER_USER_FUNCTION(Issued, 2);
        REGISTER_USER_FUNCTION(Possessed, 3);
        REGISTER_USER_FUNCTION(NextId, 4);
        REGISTER_USER_FUNCTION(Last, 5);
    }
};
