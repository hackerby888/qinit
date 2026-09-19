// Records the tick its INITIALIZE ran in and logs from inside it, so a test can see when a deployed slot is constructed and under which log range.
using namespace QPI;

struct InitWitness2
{
};

struct InitWitness : public ContractBase
{
    struct StateData
    {
        uint64 marker;
        uint64 initializeTick;
    };

    struct LogMessage
    {
        uint32 _contractIndex;
        uint32 _type;
        uint64 tick;
        sint8 _terminator;
    };

    struct Seen_input {};
    struct Seen_output
    {
        uint64 marker;
        uint64 initializeTick;
    };
    struct INITIALIZE_locals
    {
        LogMessage message;
    };

    PUBLIC_FUNCTION(Seen)
    {
        output.marker = state.get().marker;
        output.initializeTick = state.get().initializeTick;
    }

    INITIALIZE_WITH_LOCALS()
    {
        state.mut().marker = 0x494E495445444E45ull;
        state.mut().initializeTick = qpi.tick();
        locals.message._contractIndex = 0;
        locals.message._type = 1;
        locals.message.tick = qpi.tick();
        locals.message._terminator = 0;
        LOG_INFO(locals.message);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Seen, 1);
    }
};
