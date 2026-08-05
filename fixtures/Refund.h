using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData {};

    POST_INCOMING_TRANSFER()
    {
        qpi.transfer(input.sourceId, input.amount);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {}
};
