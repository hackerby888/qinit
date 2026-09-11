// Probe: reading a 64-bit word out of the SELF identity constant, directly and through a local copy.
using namespace QPI;

struct SelfWord2
{
};

struct SelfWord : public ContractBase
{
    struct StateData
    {
        uint64 direct;
        uint64 viaLocal;
        uint64 equal;
    };

    struct Snap_input
    {
        uint64 seed;
    };

    struct Snap_output
    {
    };

    struct Snap_locals
    {
        id copy;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Snap)
    {
        locals.copy = SELF;
        state.mut().viaLocal = locals.copy.u64._0;
        state.mut().direct = SELF.u64._0;
        state.mut().equal = state.get().direct == state.get().viaLocal ? 1 : 0;
    }

    struct Read_input
    {
    };

    struct Read_output
    {
        uint64 direct;
        uint64 viaLocal;
        uint64 equal;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.direct = state.get().direct;
        output.viaLocal = state.get().viaLocal;
        output.equal = state.get().equal;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Snap, 1);
    }

    INITIALIZE()
    {
        state.mut().direct = 0;
        state.mut().viaLocal = 0;
        state.mut().equal = 0;
    }
};
