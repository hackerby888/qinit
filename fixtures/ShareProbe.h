// Share-management sysproc fixture: POST_INCOMING_TRANSFER fires when the contract receives a transfer.
// Records the incoming amount (proves a sysproc WITH input marshalling runs on-chain). GetLast reads it.
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct StateData { uint64 lastAmount; };
    struct GetLast_input {}; struct GetLast_output { uint64 amount; };
    PUBLIC_FUNCTION(GetLast) { output.amount = state.get().lastAmount; }
    POST_INCOMING_TRANSFER() { state.mut().lastAmount = input.amount; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(GetLast, 1); }
    INITIALIZE() { state.mut().lastAmount = 0; }
};
