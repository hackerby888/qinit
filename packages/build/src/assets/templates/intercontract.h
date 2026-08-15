// Calls the Counter contract at a lower slot. Qinit discovers contracts/Counter.h.
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

    struct ReadCounter_locals { Counter::Get_input gi; Counter::Get_output go; };
    PUBLIC_FUNCTION_WITH_LOCALS(ReadCounter)
    {
        CALL_OTHER_CONTRACT_FUNCTION(Counter, Get, locals.gi, locals.go);
        output.value = locals.go.value;
    }

    struct BumpCounter_locals { Counter::Inc_input ii; Counter::Inc_output io; };
    PUBLIC_PROCEDURE_WITH_LOCALS(BumpCounter)
    {
        INVOKE_OTHER_CONTRACT_PROCEDURE(Counter, Inc, locals.ii, locals.io, 0);
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
