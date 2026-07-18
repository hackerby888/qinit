using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 ticks;
        uint64 endticks;
        uint64 epochs;
        uint64 endepochs;
    };

    struct Get_input {};
    struct Get_output
    {
        uint64 ticks;
        uint64 endticks;
        uint64 epochs;
        uint64 endepochs;
    };

    PUBLIC_FUNCTION(Get)
    {
        output.ticks = state.get().ticks;
        output.endticks = state.get().endticks;
        output.epochs = state.get().epochs;
        output.endepochs = state.get().endepochs;
    }

    BEGIN_TICK()
    {
        state.mut().ticks += 1;
    }

    END_TICK()
    {
        state.mut().endticks += 1;
    }

    BEGIN_EPOCH()
    {
        state.mut().epochs += 1;
    }

    END_EPOCH()
    {
        state.mut().endepochs += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Get, 1);
    }
};
