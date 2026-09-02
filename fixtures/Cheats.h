// Cheatcode fixture: exercises CC_PRINT with literals and values, plus the assert form.
// Every CC_* here must vanish under `strip`, leaving a contract byte-identical to a cheat-free build.
using namespace QPI;

struct Cheats2
{
};

struct Cheats : public ContractBase
{
    struct StateData
    {
        uint64 total;
    };

    struct Add_input
    {
        uint64 amount;
    };
    struct Add_output
    {
    };
    struct Total_input
    {
    };
    struct Total_output
    {
        uint64 total;
    };

    PUBLIC_PROCEDURE(Add)
    {
        CC_PRINT("adding", input.amount);
        CC_ASSERT(input.amount > 0);
        state.mut().total += input.amount;
        CC_PRINT("total is now", state.get().total);
    }

    PUBLIC_FUNCTION(Total)
    {
        CC_PRINT("reading total");
        output.total = state.get().total;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Add, 1);
        REGISTER_USER_FUNCTION(Total, 1);
    }
};
