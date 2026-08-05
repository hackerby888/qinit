using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData { uint64 dummy; };

    struct LogMessage
    {
        uint32 _contractIndex;
        uint32 _type;
        sint64 amount;
        sint8 _terminator;
    };
    struct POST_INCOMING_TRANSFER_locals { LogMessage message; };

    POST_INCOMING_TRANSFER_WITH_LOCALS()
    {
        locals.message.amount = input.amount;
        LOG_INFO(locals.message);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {}
};
