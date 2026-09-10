// Probe: the global-scope qualifier `::name`, which is legal C++ and is how a file-scope name is
// reached when something nearer hides it.
using namespace QPI;

static constexpr uint64 threshold = 7;

namespace Port
{
static constexpr uint64 threshold = 100;
}

struct GlobalScope2
{
};

struct GlobalScope : public ContractBase
{
    struct StateData
    {
        uint64 viaGlobalQualifier;
        uint64 viaNamespace;
        uint64 calls;
    };

    struct Set_input
    {
        uint64 value;
    };

    struct Set_output
    {
    };

    struct Set_locals
    {
        uint64 scratch;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Set)
    {
        locals.scratch = input.value;
        state.mut().viaGlobalQualifier = locals.scratch > ::threshold ? 1 : 0;
        state.mut().viaNamespace = locals.scratch > Port::threshold ? 1 : 0;
        state.mut().calls++;
    }

    struct Read_input
    {
    };

    struct Read_output
    {
        uint64 viaGlobalQualifier;
        uint64 viaNamespace;
        uint64 calls;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.viaGlobalQualifier = state.get().viaGlobalQualifier;
        output.viaNamespace = state.get().viaNamespace;
        output.calls = state.get().calls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Set, 1);
    }

    INITIALIZE()
    {
        state.mut().viaGlobalQualifier = 0;
        state.mut().viaNamespace = 0;
        state.mut().calls = 0;
    }
};
