// Sysproc fixture: INITIALIZE sets counter=42 (a non-zero marker). If Get returns 42 after deploy, the
// wasm contract's INITIALIZE ran (not zero-init). Inc proves the procedure path still works on top.
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct StateData { uint64 counter; };
    struct Inc_input {}; struct Inc_output {};
    struct Get_input {}; struct Get_output { uint64 value; };
    PUBLIC_PROCEDURE(Inc) { state.mut().counter += 1; }
    PUBLIC_FUNCTION(Get) { output.value = state.get().counter; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Inc, 1); REGISTER_USER_FUNCTION(Get, 1); }
    INITIALIZE() { state.mut().counter = 42; }
};
