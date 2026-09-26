// Calls qpi.setShareholderProposal() on a target contract (its slot passed as input), with a
// marker byte in the 1024-byte proposal buffer — triggers the target's SET_SHAREHOLDER_PROPOSAL callback.
using namespace QPI;

struct ShareProposer2
{
};

struct ShareProposer : public ContractBase
{
    struct StateData
    {
        uint64 dummy;
        uint64 proposalReturn;
        uint64 voteReturn;
    };

    struct Propose_input { uint16 target; };
    struct Propose_output {};
    struct Propose_locals { Array<uint8, 1024> buf; };

    PUBLIC_PROCEDURE_WITH_LOCALS(Propose)
    {
        locals.buf.set(0, 222);
        state.mut().proposalReturn = qpi.setShareholderProposal(input.target, locals.buf, 0);
    }

    struct Vote_input { uint16 target; };
    struct Vote_output {};
    struct Vote_locals { ProposalMultiVoteDataV1 vote; };

    PUBLIC_PROCEDURE_WITH_LOCALS(Vote)
    {
        locals.vote.proposalIndex = 7;
        state.mut().voteReturn = qpi.setShareholderVotes(input.target, locals.vote, 0) ? 1 : 0;
    }

    struct GetReturns_input {};
    struct GetReturns_output
    {
        uint64 proposalReturn;
        uint64 voteReturn;
    };

    PUBLIC_FUNCTION(GetReturns)
    {
        output.proposalReturn = state.get().proposalReturn;
        output.voteReturn = state.get().voteReturn;
    }

    // defined so a receiver calling back in would get 9 if the re-entry guard let it through.
    SET_SHAREHOLDER_PROPOSAL()
    {
        output = 9;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Propose, 1);
        REGISTER_USER_PROCEDURE(Vote, 2);
        REGISTER_USER_FUNCTION(GetReturns, 1);
    }
};
