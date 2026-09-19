// Counts every tick and epoch hook and every incoming transfer, and fails on request: what a node still runs for a contract that errored.
using namespace QPI;

struct HookFault2
{
};

struct HookFault : public ContractBase
{
    struct StateData
    {
        uint64 beginTicks;
        uint64 endTicks;
        uint64 beginEpochs;
        uint64 endEpochs;
        uint64 incomingTransfers;
        uint64 deposits;
    };

    struct Seen_input {};
    struct Seen_output
    {
        uint64 beginTicks;
        uint64 endTicks;
        uint64 beginEpochs;
        uint64 endEpochs;
        uint64 incomingTransfers;
        uint64 deposits;
    };
    struct Fail_input {};
    struct Fail_output {};
    struct FailFn_input {};
    struct FailFn_output {};
    struct Deposit_input {};
    struct Deposit_output {};

    PUBLIC_FUNCTION(Seen)
    {
        output.beginTicks = state.get().beginTicks;
        output.endTicks = state.get().endTicks;
        output.beginEpochs = state.get().beginEpochs;
        output.endEpochs = state.get().endEpochs;
        output.incomingTransfers = state.get().incomingTransfers;
        output.deposits = state.get().deposits;
    }

    PUBLIC_FUNCTION(FailFn)
    {
        CC_ASSERT(false);
    }

    PUBLIC_PROCEDURE(Fail)
    {
        CC_ASSERT(false);
    }

    PUBLIC_PROCEDURE(Deposit)
    {
        state.mut().deposits++;
    }

    BEGIN_TICK()
    {
        state.mut().beginTicks++;
    }

    END_TICK()
    {
        state.mut().endTicks++;
    }

    BEGIN_EPOCH()
    {
        state.mut().beginEpochs++;
    }

    END_EPOCH()
    {
        state.mut().endEpochs++;
    }

    POST_INCOMING_TRANSFER()
    {
        state.mut().incomingTransfers++;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Seen, 1);
        REGISTER_USER_FUNCTION(FailFn, 2);
        REGISTER_USER_PROCEDURE(Fail, 1);
        REGISTER_USER_PROCEDURE(Deposit, 2);
    }
};
