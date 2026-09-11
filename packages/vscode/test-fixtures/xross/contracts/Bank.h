using namespace QPI;

struct Bank2
{
};

// Middle of the diamond: Teller calls Bank, Bank references Ledger's types. Deliberately the worst
// shapes a contract can hold — typedefs, nested structs, struct map keys, containers of containers,
// arrays of structs, and another callee's type inside its own state.
struct Bank : public ContractBase
{
    typedef Array<uint64, 8> Hist;

    struct Tier
    {
        Array<uint64, 4> bits;
        sint16 rank;
    };

    // Two levels deep, and every field a different flavour: nested struct, typedef'd container, scalar.
    struct Tranche
    {
        Tier tier;
        Hist hist;
        uint8 flags;
    };

    struct Key
    {
        uint64 a;
        uint32 b;

        bool operator==(const Key& other) const
        {
            return a == other.a && b == other.b;
        }
    };

    struct Lot
    {
        uint64 qty;
        Tier tier;
    };

    struct StateData
    {
        HashMap<Key, Lot, 64> lots;
        Array<HashMap<id, uint64, 32>, 4> shards;
        Array<Array<uint64, 4>, 4> grid;
        Collection<Lot, 128> queue;
        LinkedList<Tier, 32> chain;
        BitArray<256> flags;
        Ledger::Entry lastEntry;
        Tranche tranche;
        uint64 marker;
    };

    struct Quote_input
    {
        Tranche tranche;
        Hist hist;
        Key key;
        Array<Lot, 4> lots;
        Array<Array<uint64, 4>, 4> grid;
        BitArray<64> flags;
        Ledger::Stamp stamp;
        id who;
        sint16 offset;
    };
    struct Quote_output
    {
        Lot lot;
        Tier tier;
        uint64 value;
    };

    struct Quote_locals
    {
        Ledger::Note_input note;
        Ledger::Note_output noteOut;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Quote)
    {
        locals.note.entry.stamp.at = 0;
        CALL_OTHER_CONTRACT_FUNCTION(Ledger, Note, locals.note, locals.noteOut);
        output.value = state.get().marker + locals.noteOut.seq;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Quote, 1);
    }
};
