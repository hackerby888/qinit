// v2 of MigrateTrapV1.h: the MIGRATE aborts when the old counter is non-zero, so a redeploy over a used
// v1 exercises a failing migration.
using namespace QPI;

struct MigrateTrap2
{
};

struct MigrateTrap : public ContractBase
{
    struct StateData
    {
        uint64 counter;
        uint64 migratedAt;
    };

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
        uint64 migratedAt;
    };

    PUBLIC_PROCEDURE(Inc)
    {
        state.mut().counter += 1;
    }

    PUBLIC_FUNCTION(Get)
    {
        output.value = state.get().counter;
        output.migratedAt = state.get().migratedAt;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Inc, 1);
        REGISTER_USER_FUNCTION(Get, 1);
    }

    MIGRATE()
    {
        CC_ASSERT(oldState.counter == 0);
        state.mut().counter = oldState.counter;
        state.mut().migratedAt = qpi.tick();
    }
};
