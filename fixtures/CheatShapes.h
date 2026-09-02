// Every argument shape CC_PRINT accepts, in one contract: bare and nested structs, an empty struct,
// sub-word scalars, containers, an id, an rvalue, ordinals other than one, and a print on each side of
// an unbraced else. Get is the exact function from the report that first lost its print rows.
using namespace QPI;

struct CheatShapes2
{
};

struct CheatShapes : public ContractBase
{
    struct ABC
    {
        uint64 a;
        uint16 b;
    };

    struct StateData
    {
        uint64 counter;
        Array<uint64, 4> nums;
        Array<ABC, 2> items;
        id owner;
        HashMap<id, uint64, 4> balances;
    };

    struct Get_input
    {
    };
    struct Get_output
    {
        uint64 value;
    };
    struct Put_input
    {
        ABC abc;
        sint32 neg;
        bit flag;
    };
    struct Put_output
    {
    };

    PUBLIC_FUNCTION(Get)
    {
        CC_PRINT("Counter is", output.value);
        output.value = state.get().counter;
        CC_PRINT("Counter is", output.value + 2, "after adding 2");
        CC_PRINT(input);
        CC_PRINT(output);
        CC_PRINT(state.get());
    }

    PUBLIC_PROCEDURE(Put)
    {
        CC_PRINT(input.abc, input.abc.b, input.neg, input.flag);
        CC_PRINT("nums", state.get().nums, "second", state.get().nums.get(1), "item", state.get().items.get(0));
        CC_PRINT("owner", state.get().owner, "caller", qpi.invocator());
        CC_PRINT(state.get().balances);
        CC_PRINT("neg plus one", input.neg + 1);
        if (input.flag)
            CC_PRINT("flag set");
        else
            CC_PRINT("flag clear");
        state.mut().counter = input.abc.a;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Get, 1);
        REGISTER_USER_PROCEDURE(Put, 1);
    }
};
