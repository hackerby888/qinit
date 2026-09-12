using namespace QPI;

struct Orphan2
{
};

// A sibling nobody calls that cannot be analysed: `Missing` is not a contract in this project. Keeps the
// drop-reporting path covered now that the diamond itself resolves.
struct Orphan : public ContractBase
{
    struct StateData
    {
        uint64 count;
        Missing::Thing thing;
    };

    struct Get_input
    {
    };
    struct Get_output
    {
        uint64 value;
    };

    PUBLIC_FUNCTION(Get)
    {
        output.value = state.get().count;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Get, 1);
    }
};
