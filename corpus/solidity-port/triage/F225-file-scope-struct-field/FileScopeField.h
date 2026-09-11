// F225 — a file-scope struct's field type resolves to the contract's same-named nested struct.
//
// `Outer` is declared at file scope, so its member `Inner inner` names the file-scope `Inner` (16
// bytes). The contract declares its own `Inner` (8 bytes). Class scope does not reach into a
// file-scope struct's body, so sizeof(Outer) is 16 in C++ — clang says 16, the TypeScript backend
// says 8, having resolved Outer's field in the contract's scope instead of Outer's own.
//
// sizeof(Inner) read from inside the contract is the control: there the contract's own Inner really
// does win, both backends say 8, and the row is about the file-scope struct only.
using namespace QPI;

struct Inner
{
    uint64 wide;
    uint64 tail;
};

struct Outer
{
    Inner inner;
};

struct FileScopeField2
{
};

struct FileScopeField : public ContractBase
{
    struct Inner
    {
        uint64 narrow;
    };

    struct StateData
    {
        uint64 innerSize;
        uint64 outerSize;
        uint64 calls;
    };

    struct Measure_input {};
    struct Measure_output {};

    PUBLIC_PROCEDURE(Measure)
    {
        state.mut().innerSize = sizeof(Inner);
        state.mut().outerSize = sizeof(Outer);
        state.mut().calls++;
    }

    struct Read_input {};
    struct Read_output
    {
        uint64 innerSize;
        uint64 outerSize;
        uint64 calls;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.innerSize = state.get().innerSize;
        output.outerSize = state.get().outerSize;
        output.calls = state.get().calls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Measure, 1);
    }

    INITIALIZE()
    {
        state.mut().innerSize = 0;
        state.mut().outerSize = 0;
        state.mut().calls = 0;
    }
};
