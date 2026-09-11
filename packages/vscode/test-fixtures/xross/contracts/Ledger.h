using namespace QPI;

struct Ledger2
{
};

// Deepest callee in the diamond. Teller reaches these types directly AND through Bank's state.
struct Ledger : public ContractBase
{
    struct Stamp
    {
        uint64 at;
        bit valid;
    };

    // Nested two deep: Entry -> Stamp -> at.
    struct Entry
    {
        Stamp stamp;
        Array<uint64, 4> amounts;
        id who;
    };

    struct StateData
    {
        HashMap<id, Entry, 64> book;
        uint64 seq;
    };

    struct Note_input
    {
        Entry entry;
    };
    struct Note_output
    {
        uint64 seq;
        Stamp stamp;
    };

    PUBLIC_FUNCTION(Note)
    {
        output.seq = state.get().seq;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Note, 1);
    }
};
