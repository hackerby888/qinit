// SET_SHAREHOLDER_PROPOSAL / SET_SHAREHOLDER_VOTES receiver. The callbacks fire when another contract calls
// qpi.setShareholderProposal() or qpi.setShareholderVotes() targeting this one; records what arrived + a count.
using namespace QPI;

struct ShareReceiver2
{
};

struct ShareReceiver : public ContractBase
{
    struct StateData
    {
        uint64 lastByte0;
        uint64 count;
        uint64 voteCount;
        uint64 lastVoteProposalIndex;
        uint64 reentryReturn;
    };

    struct GetLast_input {};
    struct GetLast_output
    {
        uint64 byte0;
        uint64 count;
        uint64 voteCount;
        uint64 lastVoteProposalIndex;
        uint64 reentryReturn;
    };

    PUBLIC_FUNCTION(GetLast)
    {
        output.byte0 = state.get().lastByte0;
        output.count = state.get().count;
        output.voteCount = state.get().voteCount;
        output.lastVoteProposalIndex = state.get().lastVoteProposalIndex;
        output.reentryReturn = state.get().reentryReturn;
    }

    // calling back into the proposer from inside the callback is refused: the stored return is INVALID_PROPOSAL_INDEX.
    SET_SHAREHOLDER_PROPOSAL()
    {
        state.mut().lastByte0 = input.get(0);
        state.mut().count += 1;
        state.mut().reentryReturn = qpi.setShareholderProposal((uint16)qpi.invocator().u64._0, input, 0);
        output = 7;
    }

    SET_SHAREHOLDER_VOTES()
    {
        state.mut().voteCount += 1;
        state.mut().lastVoteProposalIndex = input.proposalIndex;
        output = true;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(GetLast, 1);
    }
};
