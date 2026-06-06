// SET_SHAREHOLDER_PROPOSAL receiver. The callback fires when another contract calls
// qpi.setShareholderProposal() targeting this one; records the proposal's first byte + a count.
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct StateData { uint64 lastByte0; uint64 count; };
    struct GetLast_input {}; struct GetLast_output { uint64 byte0; uint64 count; };
    PUBLIC_FUNCTION(GetLast) { output.byte0 = state.get().lastByte0; output.count = state.get().count; }
    SET_SHAREHOLDER_PROPOSAL()
    {
        state.mut().lastByte0 = input.get(0);
        state.mut().count += 1;
        output = 7;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(GetLast, 1); }
    INITIALIZE() { state.mut().lastByte0 = 0; state.mut().count = 0; }
};
