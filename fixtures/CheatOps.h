// Exercises the mutating cheatcodes and the assert. Separate from Cheats.h so the strip gate and the
// cross-compiler parity check keep working on a contract that only prints. Each procedure hands back
// what the contract observed, so a test reads the effect from the output rather than from the host.
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
    struct Pay_input
    {
        id to;
        uint64 amount;
    };
    struct Pay_output
    {
    };
    struct Epoch_input
    {
        uint64 epochs;
    };
    struct Epoch_output
    {
        uint16 epoch;
    };
    struct Prank_input
    {
        id who;
    };
    struct Prank_output
    {
        id during;
        id after;
    };
    struct Check_input
    {
        uint64 amount;
    };
    struct Check_output
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

    PUBLIC_PROCEDURE(Pay)
    {
        CC_PAY(input.to, input.amount);
        state.mut().seen += 1;
    }

    PUBLIC_PROCEDURE(Epoch)
    {
        CC_WARP_EPOCH(input.epochs);
        output.epoch = qpi.epoch();
    }

    PUBLIC_PROCEDURE(Prank)
    {
        CC_PRANK(input.who, 0);
        output.during = qpi.invocator();
        CC_UNPRANK();
        output.after = qpi.invocator();
    }

    PUBLIC_PROCEDURE(Check)
    {
        CC_ASSERT(input.amount > 0);
        state.mut().seen += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Fund, 1);
        REGISTER_USER_PROCEDURE(Jump, 2);
        REGISTER_USER_PROCEDURE(Pay, 3);
        REGISTER_USER_PROCEDURE(Epoch, 4);
        REGISTER_USER_PROCEDURE(Prank, 5);
        REGISTER_USER_PROCEDURE(Check, 6);
    }
};
