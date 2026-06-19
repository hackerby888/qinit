// Shareholder-governance fixture: setShareholderProposal across contracts. The callee side defines
// SET_SHAREHOLDER_PROPOSAL (records the proposal's first byte, returns a fixed proposal index). The caller side
// (Propose) invokes another Gov instance's SET_SHAREHOLDER_PROPOSAL via qpi.setShareholderProposal.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint8 lastByte;
    };

    struct Propose_input { uint16 calleeIdx; uint8 firstByte; };
    struct Propose_output { uint16 result; };
    struct Propose_locals { Array<uint8, 1024> buf; };
    struct GetLast_input {};
    struct GetLast_output { uint8 lastByte; };

    SET_SHAREHOLDER_PROPOSAL()
    {
        state.mut().lastByte = input.get(0);
        output = 42;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Propose)
    {
        locals.buf.set(0, input.firstByte);
        output.result = qpi.setShareholderProposal(input.calleeIdx, locals.buf, 0);
    }

    PUBLIC_FUNCTION(GetLast)
    {
        output.lastByte = state.get().lastByte;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Propose, 1);
        REGISTER_USER_FUNCTION(GetLast, 1);
    }

    INITIALIZE()
    {
        state.mut().lastByte = 0;
    }
};
