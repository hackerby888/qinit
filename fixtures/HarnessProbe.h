// Harness-probe fixture: reports what the engine shows a contract (chain time, asset shares, state, qu transfers),
// so a gtest can hold it against the harness's direct view of the same ledgers.
using namespace QPI;

struct HarnessProbe2
{
};

struct HarnessProbe : public ContractBase
{
    struct StateData
    {
        uint64 value;
    };

    struct Now_input {};
    struct Now_output { uint16 epoch; uint32 tick; };
    struct Shares_input { Asset asset; };
    struct Shares_output { sint64 shares; };
    struct Read_input {};
    struct Read_output { uint64 value; };
    struct Set_input { uint64 value; };
    struct Set_output {};
    struct Pay_input { id dest; sint64 amount; };
    struct Pay_output { sint64 remaining; };

    PUBLIC_FUNCTION(Now)
    {
        output.epoch = qpi.epoch();
        output.tick = qpi.tick();
    }

    PUBLIC_FUNCTION(Shares)
    {
        output.shares = qpi.numberOfShares(input.asset);
    }

    PUBLIC_FUNCTION(Read)
    {
        output.value = state.get().value;
    }

    PUBLIC_PROCEDURE(Set)
    {
        state.mut().value = input.value;
    }

    PUBLIC_PROCEDURE(Pay)
    {
        output.remaining = qpi.transfer(input.dest, input.amount);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Now, 1);
        REGISTER_USER_FUNCTION(Shares, 2);
        REGISTER_USER_FUNCTION(Read, 3);
        REGISTER_USER_PROCEDURE(Set, 1);
        REGISTER_USER_PROCEDURE(Pay, 2);
    }

    INITIALIZE()
    {
        state.mut().value = 0;
    }
};
