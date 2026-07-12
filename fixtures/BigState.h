// Big-state fixture: 64MB state (2^26). Set writes a marker at offset 0 AND near the 64MB end; Get reads both
// back. Proves the system allocator gives the instance 64MB linear memory, the 1GB dyn slot holds it, and the
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        Array<uint8, 64*1024*1024> data;
    };

    struct Set_input { uint64 v; };
    struct Set_output {};
    struct Get_input {};
    struct Get_output { uint64 v; };

    PUBLIC_PROCEDURE(Set)
    {
        state.mut().data.set(0, (uint8)input.v);
        state.mut().data.set(60000000, (uint8)(input.v >> 8));
    }

    PUBLIC_FUNCTION(Get)
    {
        output.v = (uint64)state.get().data.get(0) | ((uint64)state.get().data.get(60000000) << 8);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Set, 1);
        REGISTER_USER_FUNCTION(Get, 1);
    }
};
