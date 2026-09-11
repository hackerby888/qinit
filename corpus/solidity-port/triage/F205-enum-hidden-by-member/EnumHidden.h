// Minimal repro for F205: an unqualified name that is both a file-scope enum constant and a member of
// the contract. C++ looks up a name inside a member function in class scope first, so `Helper` is the
// member function and assigning it to a uint64 is an error; clang says so. The TypeScript backend takes
// the enum constant instead and compiles the contract, storing 3.
//
// Reduced from corpus/solidity-port/variants/namespaces/NsEnumConstantHiddenByMember__base.h.
//
// `Solo` is the control: the same assignment through an enum constant no member shadows, which both
// backends accept and both store as 4. So the disagreement is specifically about the hiding rule, not
// about enum constants.
using namespace QPI;

enum Kind { Helper = 3, Solo = 4 };

struct EnumHidden2
{
};

struct EnumHidden : public ContractBase
{
    struct StateData
    {
        uint64 hidden;
        uint64 control;
        uint64 helperCalls;
    };

    struct Helper_input
    {
        uint64 value;
    };

    struct Helper_output
    {
        uint64 doubled;
    };

    PRIVATE_FUNCTION(Helper)
    {
        output.doubled = input.value * 2;
    }

    struct Assign_input
    {
        uint64 seed;
    };

    struct Assign_output
    {
    };

    struct Assign_locals
    {
        Helper_input request;
        Helper_output reply;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Assign)
    {
        locals.request.value = input.seed;
        CALL(Helper, locals.request, locals.reply);
        state.mut().helperCalls += locals.reply.doubled;
        // The finding: class scope hides the file-scope enum constant, so this names the member.
        state.mut().hidden = Helper;
        // The control: nothing in class scope is called Solo.
        state.mut().control = Solo;
    }

    struct Read_input
    {
    };

    struct Read_output
    {
        uint64 hidden;
        uint64 control;
        uint64 helperCalls;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.hidden = state.get().hidden;
        output.control = state.get().control;
        output.helperCalls = state.get().helperCalls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Assign, 1);
    }

    INITIALIZE()
    {
        state.mut().hidden = 0;
        state.mut().control = 0;
        state.mut().helperCalls = 0;
    }
};
