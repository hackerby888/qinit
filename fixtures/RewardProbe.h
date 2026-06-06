// ctx-field fixture: Rec records qpi.invocationReward() (an inline ctx accessor). If Get returns the amount
// attached to the Rec call, the contract's QpiContext was populated (the ctx-copy fix works).
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct StateData { uint64 lastReward; };
    struct Rec_input {}; struct Rec_output {};
    struct Get_input {}; struct Get_output { uint64 v; };
    PUBLIC_PROCEDURE(Rec) { state.mut().lastReward = (uint64)qpi.invocationReward(); }
    PUBLIC_FUNCTION(Get) { output.v = state.get().lastReward; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Rec, 1); REGISTER_USER_FUNCTION(Get, 1); }
    INITIALIZE() { state.mut().lastReward = 0; }
};
