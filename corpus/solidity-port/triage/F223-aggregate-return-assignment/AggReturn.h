// Minimal repro for F223: assigning a helper's aggregate return into an aggregate local stores a
// default-constructed value instead of the returned one.
//
// Found while auditing F203's fix. The emitted wasm computes the call correctly, into a scratch slot,
// and then ignores it:
//
//     (call $h_widen (local.get $__qinit_tmp9) ...)                          ;; result -> tmp9
//     (call $T2_uint128_t_uint128_t (local.get $__qinit_tmp8) (i64.const 0)) ;; construct uint128_t(0)
//     (call $copyMem (locals+16) (local.get $__qinit_tmp8) (i32.const 16))   ;; copy THAT, not tmp9
//
// An aggregate-returning call in value context materialises into scratch and then returns
// `(i64.const 0)`, discarding the address; the assignment sees a scalar 0 and runs uint128_t's
// converting constructor on it.
//
// `viaReturn` is the finding. `viaOutParam` is the control: the same value delivered through a
// reference out-parameter, which both backends store correctly. Their low halves must agree.
using namespace QPI;

struct AggReturn2
{
};

struct AggReturn : public ContractBase
{
    struct StateData
    {
        uint64 viaReturn;
        uint64 viaOutParam;
        uint64 agree;
    };

    struct Go_input
    {
        uint64 a;
    };
    struct Go_output {};
    struct Go_locals
    {
        uint128 returned;
        uint128 filled;
    };

    struct Read_input {};
    struct Read_output
    {
        uint64 viaReturn;
        uint64 viaOutParam;
        uint64 agree;
    };

    static uint128 widen(uint64 v)
    {
        uint128 out;
        out.low = v;
        out.high = 0;
        return out;
    }

    static void widenInto(uint128& out, uint64 v)
    {
        out.low = v;
        out.high = 0;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Go)
    {
        // The finding: the returned aggregate is discarded.
        locals.returned = widen(input.a);
        state.mut().viaReturn = locals.returned.low;

        // The control: the same value through an out-parameter.
        widenInto(locals.filled, input.a);
        state.mut().viaOutParam = locals.filled.low;

        state.mut().agree = (state.get().viaReturn == state.get().viaOutParam) ? 1 : 0;
    }

    PUBLIC_FUNCTION(Read)
    {
        output.viaReturn = state.get().viaReturn;
        output.viaOutParam = state.get().viaOutParam;
        output.agree = state.get().agree;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Go, 1);
    }

    INITIALIZE()
    {
    }
};
