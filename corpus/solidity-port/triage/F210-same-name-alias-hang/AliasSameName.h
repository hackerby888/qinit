// Minimal repro: a namespace-scoped alias whose name equals the aliased type's name.
using namespace QPI;

namespace Inner
{
struct Payload
{
    uint64 a;
};
}

namespace Middle
{
using Payload = Inner::Payload;
}

struct AliasSameName2
{
};

struct AliasSameName : public ContractBase
{
    struct StateData
    {
        Middle::Payload payload;
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
        state.mut().payload.a = locals.scratch;
    }

    struct Read_input
    {
    };

    struct Read_output
    {
        uint64 a;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.a = state.get().payload.a;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Set, 1);
    }

    INITIALIZE()
    {
        state.mut().payload.a = 0;
    }
};
