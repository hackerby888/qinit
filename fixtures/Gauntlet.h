// Exercises QPI arithmetic edge cases beyond the counter fixtures, including zero divisors and wrapping.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 total;
        uint64 putCount;
        sint64 lastReward;
        id lastCaller;
        HashMap<id, uint64, 1024> bal;
        Array<uint64, 8> slots;
    };

    // ---- pure arithmetic functions (deterministic; edge asserts) ----
    struct DivMod_input
    {
        uint64 a;
        uint64 b;
    };
    struct DivMod_output
    {
        uint64 q;
        uint64 r;
    };
    struct Arith_input
    {
        uint64 a;
        uint64 b;
    };
    struct Arith_output
    {
        uint64 sum;
        uint64 prod;
        uint64 xorv;
        uint64 shl;
    };
    struct SignedOp_input
    {
        sint64 a;
        sint64 b;
    };
    struct SignedOp_output
    {
        sint64 q;
        sint64 r;
        sint64 sum;
    };
    struct Hash_input { uint64 x; };
    struct Hash_output { id h; };

    // ---- state read functions ----
    struct Total_input {};
    struct Total_output { uint64 total; };
    struct PutCount_input {};
    struct PutCount_output { uint64 count; };
    struct Bal_input { id who; };
    struct Bal_output { uint64 amount; };
    struct Bal_locals { uint64 v; };
    struct Pop_input {};
    struct Pop_output { uint64 population; };
    struct Slot_input { uint64 i; };
    struct Slot_output { uint64 value; };
    struct LastCaller_input {};
    struct LastCaller_output
    {
        id who;
        sint64 reward;
    };

    // ---- procedures (mutate state) ----
    struct Add_input { uint64 x; };
    struct Add_output {};
    struct Put_input
    {
        id k;
        uint64 v;
    };
    struct Put_output {};
    struct SetSlot_input
    {
        uint64 i;
        uint64 v;
    };
    struct SetSlot_output {};
    struct Remember_input {};
    struct Remember_output {};

    PUBLIC_FUNCTION(DivMod)
    {
        output.q = div(input.a, input.b);   // div(a, 0) -> 0
        output.r = mod(input.a, input.b);   // mod(a, 0) -> 0
    }

    PUBLIC_FUNCTION(Arith)
    {
        output.sum = input.a + input.b;            // wraps mod 2^64
        output.prod = input.a * input.b;           // wraps
        output.xorv = input.a ^ input.b;
        output.shl = input.a << (input.b & 63);    // shift amount masked to a valid range
    }

    PUBLIC_FUNCTION(SignedOp)
    {
        output.q = QPI::div(input.a, input.b);   // QPI:: — unqualified div(long long,long long) hits stdlib lldiv_t
        // Signed division truncates toward zero; modulo follows the dividend sign.
        output.r = QPI::mod(input.a, input.b);
        output.sum = input.a + input.b;
    }

    PUBLIC_FUNCTION(Hash)
    {
        output.h = qpi.K12(input.x);   // KangarooTwelve of the 8 input bytes
    }

    PUBLIC_FUNCTION(Total)
    {
        output.total = state.get().total;
    }

    PUBLIC_FUNCTION(PutCount)
    {
        output.count = state.get().putCount;
    }

    PUBLIC_FUNCTION_WITH_LOCALS(Bal)
    {
        locals.v = 0;                              // get() leaves v untouched on a miss -> 0
        state.get().bal.get(input.who, locals.v);
        output.amount = locals.v;
    }

    PUBLIC_FUNCTION(Pop)
    {
        output.population = state.get().bal.population();
    }

    PUBLIC_FUNCTION(Slot)
    {
        output.value = state.get().slots.get(input.i);   // index & 7
    }

    PUBLIC_FUNCTION(LastCaller)
    {
        output.who = state.get().lastCaller;
        output.reward = state.get().lastReward;
    }

    PUBLIC_PROCEDURE(Add)
    {
        state.mut().total += input.x;
    }

    PUBLIC_PROCEDURE(Put)
    {
        state.mut().bal.set(input.k, input.v);
        state.mut().putCount += 1;
    }

    PUBLIC_PROCEDURE(SetSlot)
    {
        state.mut().slots.set(input.i, input.v);
    }

    PUBLIC_PROCEDURE(Remember)
    {
        state.mut().lastCaller = qpi.invocator();
        state.mut().lastReward = qpi.invocationReward();
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(DivMod, 1);
        REGISTER_USER_FUNCTION(Arith, 2);
        REGISTER_USER_FUNCTION(SignedOp, 3);
        REGISTER_USER_FUNCTION(Hash, 4);
        REGISTER_USER_FUNCTION(Total, 5);
        REGISTER_USER_FUNCTION(PutCount, 6);
        REGISTER_USER_FUNCTION(Bal, 7);
        REGISTER_USER_FUNCTION(Pop, 8);
        REGISTER_USER_FUNCTION(Slot, 9);
        REGISTER_USER_FUNCTION(LastCaller, 10);

        REGISTER_USER_PROCEDURE(Add, 1);
        REGISTER_USER_PROCEDURE(Put, 2);
        REGISTER_USER_PROCEDURE(SetSlot, 3);
        REGISTER_USER_PROCEDURE(Remember, 4);
    }

    INITIALIZE()
    {
        state.mut().bal.reset();
        state.mut().slots.setAll(0);
    }
};
