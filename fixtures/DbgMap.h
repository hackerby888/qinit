// Debug fixture: a HashMap in state + a scalar AFTER it. Proves the debugger computes the container's exact
// size (so `marker` names at the right offset). Bump writes marker; Get reads it.
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct StateData { HashMap<id, uint64, 1024> bal; uint64 marker; };
    struct Bump_input {}; struct Bump_output {};
    struct Put_input { id k; uint64 v; }; struct Put_output {};
    struct Get_input {}; struct Get_output { uint64 v; };
    PUBLIC_PROCEDURE(Bump) { state.mut().marker += 1; }
    PUBLIC_PROCEDURE(Put) { state.mut().bal.set(input.k, input.v); }
    PUBLIC_FUNCTION(Get) { output.v = state.get().marker; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Bump, 1); REGISTER_USER_PROCEDURE(Put, 2); REGISTER_USER_FUNCTION(Get, 1); }
    INITIALIZE() { state.mut().marker = 0; }
};
