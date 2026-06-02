// Kitchen-sink fixture for rich QPI data structures: HashMap + Array.
// Exercises HashMap<id,uint64>.set/get + Array<uint64,N> in contract state.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        HashMap<id, uint64, 1024> balances;
        Array<uint64, 4> recent;
        uint64 total;
    };

    struct Set_input { id who; uint64 amount; };
    struct Set_output {};
    struct BalanceOf_input { id who; };
    struct BalanceOf_output { uint64 amount; };
    struct Stats_input {};
    struct Stats_output { uint64 total; uint64 population; };

    PUBLIC_PROCEDURE(Set)
    {
        state.mut().balances.set(input.who, input.amount);
        state.mut().total += input.amount;
        state.mut().recent.set(0, input.amount);
    }

    PUBLIC_FUNCTION(BalanceOf)
    {
        uint64 v = 0;
        state.get().balances.get(input.who, v);
        output.amount = v;
    }

    PUBLIC_FUNCTION(Stats)
    {
        output.total = state.get().total;
        output.population = state.get().balances.population();
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Set, 1);
        REGISTER_USER_FUNCTION(BalanceOf, 1);
        REGISTER_USER_FUNCTION(Stats, 2);
    }

    INITIALIZE()
    {
        state.mut().total = 0;
        state.mut().balances.reset();
    }
};
