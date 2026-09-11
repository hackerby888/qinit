// F224, the realistic face — an iterator in _locals, read through its index accessors.
//
// The companion repro (F224-iterator-in-state) holds the iterator in StateData, which no contract
// would write. This one keeps it in _locals where it belongs and still diverges: issuanceIndex()
// and ownershipIndex() are defined inline in qpi_assets.h, so they compile from source and read
// _issuanceIdx / _ownershipIdx, which the backend's begin() never writes.
using namespace QPI;

struct IteratorIndexAccessors2
{
};

struct IteratorIndexAccessors : public ContractBase
{
    struct StateData
    {
        uint64 holders;
        uint64 shares;
        uint64 issuanceIdx;
        uint64 firstOwnershipIdx;
        uint64 lastOwnershipIdx;
    };

    struct Walk_input {};
    struct Walk_output {};
    struct Walk_locals
    {
        id other;
        Asset asset;
        AssetOwnershipIterator iter;
        uint64 guard;
        sint64 outcome;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Walk)
    {
        locals.other = id(5, 0, 0, 0);
        locals.outcome = qpi.issueAsset(5525825ULL, SELF, 0, 1000, 0);
        locals.outcome = qpi.transferShareOwnershipAndPossession(5525825ULL, SELF, SELF, SELF, 400, locals.other);
        locals.asset.issuer = SELF;
        locals.asset.assetName = 5525825ULL;

        locals.iter.begin(locals.asset, AssetOwnershipSelect::any());
        state.mut().issuanceIdx = locals.iter.issuanceIndex();
        state.mut().firstOwnershipIdx = locals.iter.ownershipIndex();
        locals.guard = 0;
        while (!locals.iter.reachedEnd() && locals.guard < 16)
        {
            state.mut().holders++;
            state.mut().shares += locals.iter.numberOfOwnedShares();
            state.mut().lastOwnershipIdx = locals.iter.ownershipIndex();
            locals.iter.next();
            locals.guard++;
        }
    }

    struct Read_input {};
    struct Read_output
    {
        uint64 holders;
        uint64 shares;
        uint64 issuanceIdx;
        uint64 firstOwnershipIdx;
        uint64 lastOwnershipIdx;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.holders = state.get().holders;
        output.shares = state.get().shares;
        output.issuanceIdx = state.get().issuanceIdx;
        output.firstOwnershipIdx = state.get().firstOwnershipIdx;
        output.lastOwnershipIdx = state.get().lastOwnershipIdx;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Walk, 1);
    }

    INITIALIZE()
    {
        state.mut().holders = 0;
        state.mut().shares = 0;
        state.mut().issuanceIdx = 0;
        state.mut().firstOwnershipIdx = 0;
        state.mut().lastOwnershipIdx = 0;
    }
};
