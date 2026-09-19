// Records what a contract reads of the chain clock inside END_EPOCH and BEGIN_EPOCH, and at the first BEGIN_TICK after a switch.
using namespace QPI;

struct EpochWitness2
{
};

struct EpochWitness : public ContractBase
{
    struct Reading
    {
        uint64 tick;
        uint64 epoch;
        uint64 initialTick;
    };

    struct StateData
    {
        Reading endEpoch;
        Reading beginEpoch;
        Reading firstBeginTick;
        uint64 switches;
        uint64 awaitingBeginTick;
    };

    struct Seen_input {};
    struct Seen_output
    {
        Reading endEpoch;
        Reading beginEpoch;
        Reading firstBeginTick;
        uint64 switches;
    };

    PUBLIC_FUNCTION(Seen)
    {
        output.endEpoch = state.get().endEpoch;
        output.beginEpoch = state.get().beginEpoch;
        output.firstBeginTick = state.get().firstBeginTick;
        output.switches = state.get().switches;
    }

    END_EPOCH()
    {
        state.mut().endEpoch.tick = qpi.tick();
        state.mut().endEpoch.epoch = qpi.epoch();
        state.mut().endEpoch.initialTick = qpi.initialTick();
    }

    BEGIN_EPOCH()
    {
        state.mut().beginEpoch.tick = qpi.tick();
        state.mut().beginEpoch.epoch = qpi.epoch();
        state.mut().beginEpoch.initialTick = qpi.initialTick();
        state.mut().switches++;
        state.mut().awaitingBeginTick = 1;
    }

    BEGIN_TICK()
    {
        if (state.get().awaitingBeginTick)
        {
            state.mut().firstBeginTick.tick = qpi.tick();
            state.mut().firstBeginTick.epoch = qpi.epoch();
            state.mut().firstBeginTick.initialTick = qpi.initialTick();
            state.mut().awaitingBeginTick = 0;
        }
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Seen, 1);
    }
};
