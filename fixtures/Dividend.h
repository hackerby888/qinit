// Phase-3 assets fixture: distributeDividends. Fund credits the contract via invocationReward; Distribute
// pays amountPerShare * NUMBER_OF_COMPUTORS out of the contract balance (true on success, false if short).
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 dummy;
    };

    struct Fund_input {};
    struct Fund_output {};
    struct Distribute_input { sint64 amountPerShare; };
    struct Distribute_output { uint64 ok; };

    PUBLIC_PROCEDURE(Fund)
    {
        // no-op: the invocationReward sent with the tx is credited to the contract by the protocol
    }

    PUBLIC_PROCEDURE(Distribute)
    {
        output.ok = qpi.distributeDividends(input.amountPerShare) ? 1 : 0;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Fund, 1);
        REGISTER_USER_PROCEDURE(Distribute, 2);
    }
};
