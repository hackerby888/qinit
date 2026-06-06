// Calls qpi.setShareholderProposal() on a target contract (its slot passed as input), with a
// marker byte in the 1024-byte proposal buffer — triggers the target's SET_SHAREHOLDER_PROPOSAL callback.
using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
    struct StateData { uint64 dummy; };
    struct Propose_input { uint16 target; };
    struct Propose_output {};
    struct Propose_locals { Array<uint8, 1024> buf; };
    PUBLIC_PROCEDURE_WITH_LOCALS(Propose)
    {
        locals.buf.set(0, 222);
        qpi.setShareholderProposal(input.target, locals.buf, 0);
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Propose, 1); }
    INITIALIZE() { state.mut().dummy = 0; }
};
