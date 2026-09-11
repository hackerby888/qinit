using namespace QPI;

struct Vault2
{
};

// Callee for the completion campaign: every QPI container in state, and an input struct whose fields
// are reached through a field hop — the shape clangd answers with an empty list.
struct Vault : public ContractBase
{
    struct Tag
    {
        Array<uint64, 4> bits;
        sint16 rank;
    };

    struct StateData
    {
        HashMap<id, uint64, 1024> balances;
        HashSet<id, 256> members;
        Collection<uint64, 128> queue;
        LinkedList<uint64, 64> chain;
        Array<Tag, 8> tags;
        BitArray<256> flags;
        uint64 marker;
    };

    struct Get_input
    {
        Array<uint64, 8> history;
        Tag detail;
        id who;
        sint16 offset;
    };
    struct Get_output
    {
        uint64 value;
    };

    PUBLIC_FUNCTION(Get)
    {
        output.value = state.get().marker;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Get, 1);
    }
};
