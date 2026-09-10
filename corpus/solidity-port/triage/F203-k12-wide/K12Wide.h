// Does the deduction fallback cover a 16-byte rvalue, or only widths 1/2/4/8?
using namespace QPI;

struct K12Wide2
{
};

struct K12Wide : public ContractBase
{
    struct StateData
    {
        id ofLocal;
        id ofExpression;
        uint64 same;
    };

    struct Go_input
    {
        uint64 a;
        uint64 b;
    };
    struct Go_output {};
    struct Go_locals
    {
        uint128 wide;
        uint128 lhs;
        uint128 rhs;
    };

    struct Read_input {};
    struct Read_output
    {
        id ofLocal;
        id ofExpression;
        uint64 same;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Go)
    {
        locals.lhs = input.a;
        locals.rhs = input.b;
        locals.wide = locals.lhs + locals.rhs;
        state.mut().ofLocal = qpi.K12(locals.wide);
        state.mut().ofExpression = qpi.K12(locals.lhs + locals.rhs);
        state.mut().same = (state.get().ofLocal == state.get().ofExpression) ? 1 : 0;
    }

    PUBLIC_FUNCTION(Read)
    {
        output.ofLocal = state.get().ofLocal;
        output.ofExpression = state.get().ofExpression;
        output.same = state.get().same;
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
