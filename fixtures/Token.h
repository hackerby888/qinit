// Asset-op fixture: issueAsset / isAssetIssued / numberOfShares. The contract issues its own
// asset (issuer = SELF), then reports issuance + total shares.
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
    struct Total_input { uint64 name; };
    struct Total_output { sint64 shares; };
    struct Issued_input { uint64 name; };
    struct Issued_output { sint64 issued; };

    PUBLIC_PROCEDURE(Issue)
    {
        output.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
        state.mut().lastResult = output.result;
    }

    PUBLIC_FUNCTION(Total)
    {
        Asset a;
        a.issuer = SELF;
        a.assetName = input.name;
        output.shares = qpi.numberOfShares(a, AssetOwnershipSelect::any(), AssetPossessionSelect::any());
    }

    PUBLIC_FUNCTION(Issued)
    {
        output.issued = qpi.isAssetIssued(SELF, input.name) ? 1 : 0;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Issue, 1);
        REGISTER_USER_FUNCTION(Total, 1);
        REGISTER_USER_FUNCTION(Issued, 2);
    }

    INITIALIZE()
    {
        state.mut().lastResult = 0;
    }
};
