using namespace QPI;

struct Feed2
{
};

// The callee. Its nested types are what Meter spells qualified, so a change here is visible in Meter.
struct Feed : public ContractBase
{
    struct Sample
    {
        uint64 at;
        uint64 value;
    };

    struct StateData
    {
        uint64 taken;
        Array<Sample, 8> recent;
    };

    struct Read_input
    {
        uint64 index;
    };
    struct Read_output
    {
        Sample sample;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.sample = state.get().recent.get(input.index);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
    }
};
