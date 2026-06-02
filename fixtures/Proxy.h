// Inter-contract caller fixture. Calls the Counter contract (deployed at a LOWER slot) using the
// upstream macros — ReadCounter reads Counter's value (CALL function), BumpCounter increments it
// (INVOKE procedure). Qinit auto-derives Counter's type + inputType constants from its source.
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

    struct ReadCounter_input {};
    struct ReadCounter_output { uint64 value; };
    struct BumpCounter_input {};
    struct BumpCounter_output {};

    PUBLIC_FUNCTION(ReadCounter)
    {
        Counter::Get_input gi;
        Counter::Get_output go;
        CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, gi, go);
        output.value = go.value;
    }

    PUBLIC_PROCEDURE(BumpCounter)
    {
        Counter::Inc_input ii;
        Counter::Inc_output io;
        INVOKE_OTHER_CONTRACT_PROCEDURE(Counter, Inc, ii, io, 0);
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(ReadCounter, 1);
        REGISTER_USER_PROCEDURE(BumpCounter, 1);
    }

    INITIALIZE()
    {
        state.mut().dummy = 0;
    }
};
