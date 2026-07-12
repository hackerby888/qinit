// Phase-3 semantics fixture: invocationReward, qpi.transfer, and the POST_INCOMING_TRANSFER + BEGIN_TICK
// lifecycle callbacks. Drives the TS engine's money model (ledger + transfer + reward + PIT trigger).
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 totalReceived; // sum of invocationReward seen by Deposit
        uint64 incomingCount; // POST_INCOMING_TRANSFER callbacks fired
        sint64 lastIncoming;  // amount of the last incoming transfer
        uint64 tickCount;     // BEGIN_TICK callbacks fired
        id     lastInvocator; // invocator of the last Deposit
        id     lastSource;    // source of the last incoming transfer
    };

    struct Deposit_input {};
    struct Deposit_output {};
    struct Send_input
    {
        id dest;
        sint64 amount;
    };
    struct Send_output { sint64 remaining; };
    struct Get_input {};
    struct Get_output
    {
        uint64 totalReceived;
        uint64 incomingCount;
        sint64 lastIncoming;
        uint64 tickCount;
    };

    PUBLIC_PROCEDURE(Deposit)
    {
        state.mut().totalReceived += qpi.invocationReward();
        state.mut().lastInvocator = qpi.invocator();
    }

    PUBLIC_PROCEDURE(Send)
    {
        output.remaining = qpi.transfer(input.dest, input.amount);
    }

    PUBLIC_FUNCTION(Get)
    {
        output.totalReceived = state.get().totalReceived;
        output.incomingCount = state.get().incomingCount;
        output.lastIncoming  = state.get().lastIncoming;
        output.tickCount     = state.get().tickCount;
    }

    POST_INCOMING_TRANSFER()
    {
        state.mut().incomingCount += 1;
        state.mut().lastIncoming = input.amount;
        state.mut().lastSource = input.sourceId;
    }

    BEGIN_TICK()
    {
        state.mut().tickCount += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Deposit, 1);
        REGISTER_USER_PROCEDURE(Send, 2);
        REGISTER_USER_FUNCTION(Get, 1);
    }
};
