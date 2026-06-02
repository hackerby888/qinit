// Second dynamic-contract fixture — exercises the full codec: id input/output,
// Array output, struct output, scalar input. Deployed to a LITEDYN slot.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        id owner;
        uint64 count;
        Array<uint64, 4> slots;
    };

    struct SetOwner_input { id who; };
    struct SetOwner_output {};
    struct Bump_input { uint64 amount; };
    struct Bump_output {};
    struct Info_input {};
    struct Info_output { id owner; uint64 count; };
    struct SlotsGet_input {};
    struct SlotsGet_output { Array<uint64, 4> slots; };

    PUBLIC_PROCEDURE(SetOwner)
    {
        state.mut().owner = input.who;
    }

    PUBLIC_PROCEDURE(Bump)
    {
        state.mut().count += input.amount;
        state.mut().slots.set(0, state.get().slots.get(0) + 1);
    }

    PUBLIC_FUNCTION(Info)
    {
        output.owner = state.get().owner;
        output.count = state.get().count;
    }

    PUBLIC_FUNCTION(SlotsGet)
    {
        output.slots = state.get().slots;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(SetOwner, 1);
        REGISTER_USER_PROCEDURE(Bump, 2);
        REGISTER_USER_FUNCTION(Info, 1);
        REGISTER_USER_FUNCTION(SlotsGet, 2);
    }

    INITIALIZE()
    {
        state.mut().count = 0;
    }
};
