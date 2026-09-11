// F224 — an asset iterator held in StateData does not match its declared layout.
//
// The backend models AssetOwnershipIterator as two i32s — a match count and a cursor — with the
// records in a global buffer. qpi_asset.h declares ~88 bytes: Asset _issuance, _issuanceIdx,
// AssetOwnershipSelect _ownership, _ownershipIdx, all of which clang's begin() fills.
//
// While the iterator lives in _locals nothing observes those bytes. Held in state they are part of
// the contract's own memory, so the two backends disagree on what the contract holds. The walk
// counters are the control: they agree, because the F220 filter fix is correct — this row is about
// the object's layout, not about the walk.
using namespace QPI;

struct IteratorInState2
{
};

struct IteratorInState : public ContractBase
{
    struct Scratch
    {
        AssetOwnershipIterator iter;
    };

    struct StateData
    {
        uint64 holders;
        uint64 shares;
        uint64 calls;
        Scratch scratch;
    };

    struct Walk_input {};
    struct Walk_output {};
    struct Walk_locals
    {
        id other;
        Asset asset;
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

        state.mut().scratch.iter.begin(locals.asset, AssetOwnershipSelect::any());
        locals.guard = 0;
        while (!state.get().scratch.iter.reachedEnd() && locals.guard < 16)
        {
            state.mut().holders++;
            state.mut().shares += state.get().scratch.iter.numberOfOwnedShares();
            state.mut().scratch.iter.next();
            locals.guard++;
        }
        state.mut().calls++;
    }

    struct Read_input {};
    struct Read_output
    {
        uint64 holders;
        uint64 shares;
        uint64 calls;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.holders = state.get().holders;
        output.shares = state.get().shares;
        output.calls = state.get().calls;
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
        state.mut().calls = 0;
    }
};
