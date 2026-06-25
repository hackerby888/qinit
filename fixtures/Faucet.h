// Context-method fixture: qpi.transfer (move QU). Send moves `amount` from the contract's
// own balance to `dest`. The invoking tx's amount funds the contract (invocationReward).
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 sent;
    };

    struct Send_input
    {
        id dest;
        uint64 amount;
    };
    struct Send_output {};
    struct Sent_input {};
    struct Sent_output { uint64 sent; };

    PUBLIC_PROCEDURE(Send)
    {
        qpi.transfer(input.dest, input.amount);
        state.mut().sent += input.amount;
    }

    PUBLIC_FUNCTION(Sent)
    {
        output.sent = state.get().sent;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Send, 1);
        REGISTER_USER_FUNCTION(Sent, 1);
    }
};
