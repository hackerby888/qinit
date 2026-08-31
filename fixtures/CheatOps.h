// Exercises the mutating cheatcodes. Separate from Cheats.h so the strip gate and the cross-compiler
// parity check keep working on a contract that only prints.
using namespace QPI;

struct CheatOps2
{
};

struct CheatOps : public ContractBase
{
    struct StateData
    {
        uint64 seen;
    };

    struct Fund_input
    {
        id who;
        uint64 amount;
    };
    struct Fund_output
    {
    };
    struct Jump_input
    {
        uint64 ticks;
    };
    struct Jump_output
    {
    };

    PUBLIC_PROCEDURE(Fund)
    {
        CC_DEAL(input.who, input.amount);
        state.mut().seen += 1;
    }

    PUBLIC_PROCEDURE(Jump)
    {
        CC_WARP_TICK(input.ticks);
        state.mut().seen += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Fund, 1);
        REGISTER_USER_PROCEDURE(Jump, 2);
    }
};
