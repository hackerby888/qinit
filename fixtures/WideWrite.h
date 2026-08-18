// Rewrites half a megabyte of state in one call — more blocks than the write journal can hold, so it
// exercises the overflow path and the fallback to snapshot diffing.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        Array<uint64, 65536> data;
    };

    struct Fill_input { uint64 v; };
    struct Fill_output {};

    PUBLIC_PROCEDURE(Fill)
    {
        state.mut().data.setAll(input.v);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Fill, 1);
    }
};
