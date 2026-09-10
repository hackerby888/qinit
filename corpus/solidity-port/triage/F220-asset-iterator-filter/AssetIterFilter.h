using namespace QPI;

struct AssetIterFilter2
{
};

struct AssetIterFilter : public ContractBase
{
    struct StateData
    {
        uint64 issued;
        uint64 transferred;
        uint64 filteredCount;
        uint64 filteredShares;
        uint64 unfilteredCount;
        uint64 unfilteredShares;
        uint64 calls;
    };

    struct Probe_input
    {
        uint64 unused;
    };
    struct Probe_output {};
    struct Probe_locals
    {
        id other;
        Asset asset;
        AssetOwnershipIterator iter;
        uint64 guard;
        sint64 outcome;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Probe)
    {
        locals.other = id(5, 0, 0, 0);
        locals.outcome = qpi.issueAsset(5525825ULL, SELF, 0, 1000, 0);
        state.mut().issued = locals.outcome;
        locals.outcome = qpi.transferShareOwnershipAndPossession(5525825ULL, SELF, SELF, SELF, 400, locals.other);
        state.mut().transferred = locals.outcome;

        locals.asset.issuer = SELF;
        locals.asset.assetName = 5525825ULL;

        // Filtered to a single owner. The C++ iterator honours the select; the question is whether
        // both backends do.
        locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.other));
        locals.guard = 0;
        while (!locals.iter.reachedEnd() && locals.guard < 16)
        {
            state.mut().filteredCount++;
            state.mut().filteredShares += locals.iter.numberOfOwnedShares();
            locals.iter.next();
            locals.guard++;
        }

        // The same walk with no filter at all, as a control.
        locals.iter.begin(locals.asset, AssetOwnershipSelect::any());
        locals.guard = 0;
        while (!locals.iter.reachedEnd() && locals.guard < 16)
        {
            state.mut().unfilteredCount++;
            state.mut().unfilteredShares += locals.iter.numberOfOwnedShares();
            locals.iter.next();
            locals.guard++;
        }
        state.mut().calls++;
    }

    struct Read_input {};
    struct Read_output
    {
        uint64 issued;
        uint64 transferred;
        uint64 filteredCount;
        uint64 filteredShares;
        uint64 unfilteredCount;
        uint64 unfilteredShares;
        uint64 calls;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.issued = state.get().issued;
        output.transferred = state.get().transferred;
        output.filteredCount = state.get().filteredCount;
        output.filteredShares = state.get().filteredShares;
        output.unfilteredCount = state.get().unfilteredCount;
        output.unfilteredShares = state.get().unfilteredShares;
        output.calls = state.get().calls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Probe, 1);
    }

    INITIALIZE()
    {
        state.mut().issued = 0;
        state.mut().transferred = 0;
        state.mut().filteredCount = 0;
        state.mut().filteredShares = 0;
        state.mut().unfilteredCount = 0;
        state.mut().unfilteredShares = 0;
        state.mut().calls = 0;
    }
};
