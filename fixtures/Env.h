// Context-read fixture: qpi.epoch / qpi.tick / qpi.numberOfTickTransactions.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 dummy;
    };

    struct Now_input {};
    struct Now_output { uint16 epoch; uint32 tick; sint32 txCount; };

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

    INITIALIZE()
    {
        state.mut().dummy = 0;
    }
};
