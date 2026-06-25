// Debug fixture: a Collection (PoV priority queues) in state. Add(pov, v, priority) inserts; the debugger
// decodes it logically (per-PoV, priority order). Cnt returns the total population.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        Collection<uint64, 1024> q;
    };

    struct Add_input
    {
        id pov;
        uint64 v;
        sint64 prio;
    };
    struct Add_output {};
    struct Cnt_input {};
    struct Cnt_output { uint64 n; };

    PUBLIC_PROCEDURE(Add)
    {
        state.mut().q.add(input.pov, input.v, input.prio);
    }

    PUBLIC_FUNCTION(Cnt)
    {
        output.n = state.get().q.population();
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Add, 1);
        REGISTER_USER_FUNCTION(Cnt, 1);
    }
};
