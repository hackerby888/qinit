// Context-read fixture: qpi.epoch / qpi.tick / qpi.numberOfTickTransactions.
using namespace QPI;

struct Env2
{
};

struct Env : public ContractBase
{
    struct StateData
    {
        uint64 dummy;
    };

    struct Now_input {};
    struct Now_output
    {
        uint16 epoch;
        uint32 tick;
        sint32 txCount;
    };

    PUBLIC_FUNCTION(Now)
    {
        output.epoch = qpi.epoch();
        output.tick = qpi.tick();
        output.txCount = qpi.numberOfTickTransactions();
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Now, 1);
    }
};
