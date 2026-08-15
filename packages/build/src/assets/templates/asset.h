using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

// Issues its own asset (issuer = SELF) and can move shares to another id.
struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        sint64 lastResult;
    };

    struct Issue_input { uint64 name; sint64 shares; };
    struct Issue_output { sint64 result; };
    struct Total_input { uint64 name; };
    struct Total_output { sint64 shares; };
    struct Move_input { uint64 name; id to; sint64 shares; };
    struct Move_output { sint64 result; };

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

    struct Total_locals { QPI::Asset a; };   // QPI:: qualified so it never clashes with a contract named "Asset"
    PUBLIC_FUNCTION_WITH_LOCALS(Total)
    {
        locals.a.issuer = SELF;
        locals.a.assetName = input.name;
        output.shares = qpi.numberOfShares(locals.a, AssetOwnershipSelect::any(), AssetPossessionSelect::any());
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Issue, 1);
        REGISTER_USER_PROCEDURE(Move, 2);
        REGISTER_USER_FUNCTION(Total, 1);
    }

    INITIALIZE()
    {
        state.mut().lastResult = 0;
    }
};
