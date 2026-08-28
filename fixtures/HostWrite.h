// The host, not the contract, writes this state: qpi.getEntity fills a caller-provided struct, so no
// wasm store ever touches the field. Store instrumentation cannot see it; the host has to record it.
using namespace QPI;

struct HostWrite2
{
};

struct HostWrite : public ContractBase
{
    struct StateData
    {
        Entity cached;
    };

    struct Cache_input {};
    struct Cache_output {};

    PUBLIC_PROCEDURE(Cache)
    {
        qpi.getEntity(qpi.invocator(), state.mut().cached);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Cache, 1);
    }
};
