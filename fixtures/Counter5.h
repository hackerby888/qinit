// Counter variant: Inc adds 5 (upgradeability proof for inter-contract runtime dispatch).
// Same fn/proc inputTypes as Counter, deployed over slot 28; Proxy (built against Counter@28,
// unchanged) must see +5 per BumpCounter -> proves it runs the DEPLOYED code, not an inlined copy.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 counter;
    };

    struct Inc_input {};
    struct Inc_output {};
    struct Get_input {};
    struct Get_output { uint64 value; };

    PUBLIC_PROCEDURE(Inc)
    {
        state.mut().counter += 5;
    }

    PUBLIC_FUNCTION(Get)
    {
        output.value = state.get().counter;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Inc, 1);
        REGISTER_USER_FUNCTION(Get, 1);
    }

    INITIALIZE()
    {
        state.mut().counter = 0;
    }
};
