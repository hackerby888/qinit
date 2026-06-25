// Migration fixture for `qinit build` + the migrate tests. v2 of Counter.h: StateData gains a field and a
// MIGRATE() carries the old counter forward (OldStateData == v1 StateData). Exercises state migration on redeploy.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 counter;
        uint64 lastMigratedTick;
    };

    // The prior version's StateData layout — MIGRATE() reads the live old state through this.
    struct OldStateData
    {
        uint64 counter;
    };

    struct Inc_input {};
    struct Inc_output {};
    struct Get_input {};
    struct Get_output
    {
        uint64 value;
        uint64 lastMigratedTick;
    };

    PUBLIC_PROCEDURE(Inc)
    {
        state.mut().counter += 1;
    }

    PUBLIC_FUNCTION(Get)
    {
        output.value = state.get().counter;
        output.lastMigratedTick = state.get().lastMigratedTick;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Inc, 1);
        REGISTER_USER_FUNCTION(Get, 1);
    }

    MIGRATE()
    {
        state.mut().counter = oldState.counter;
        state.mut().lastMigratedTick = qpi.tick();
    }
};
