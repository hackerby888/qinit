// Fault-injection fixture: Div does a raw integer division (input.a / input.b) which the wasm executes as
// i64.div — a wasm TRAP on b == 0. Used to assert the engine isolates a faulting procedure (the tick survives,
// state rolls back) instead of crashing. qpi-DIRTY on purpose (raw /), so it builds only with skipVerify.
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData { uint64 n; };
    struct Bump_input {}; struct Bump_output {};
    struct Div_input { uint64 a; uint64 b; }; struct Div_output {};
    struct Get_input {}; struct Get_output { uint64 value; };

    PUBLIC_PROCEDURE(Bump) { state.mut().n += 1; }
    PUBLIC_PROCEDURE(Div)  { state.mut().n = input.a / input.b; }
    PUBLIC_FUNCTION(Get)   { output.value = state.get().n; }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Bump, 1);
        REGISTER_USER_PROCEDURE(Div, 2);
        REGISTER_USER_FUNCTION(Get, 1);
    }
};
