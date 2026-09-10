// Minimal repro for F213: two enums with the same name in two namespaces, each with the same constant
// names and different values. Every use below is fully qualified, so C++ has no ambiguity: Alpha::Low
// is 1 and Beta::Low is 100.
//
// clang stores 1, 2, 100, 200 and 200. The TypeScript backend stores 100, 200, 100, 200 and 20000 —
// every Alpha:: constant resolves to Beta's, i.e. to the enum declared last.
//
// The control is the pair below it: TwinName::Only and OtherName::Only differ in *enum* name as well,
// and both backends agree on those.
using namespace QPI;

namespace Alpha
{
enum Level { Low = 1, High = 2 };
}

namespace Beta
{
enum Level { Low = 100, High = 200 };
}

namespace TwinName
{
enum FirstKind { Only = 7 };
}

namespace OtherName
{
enum SecondKind { Only = 9 };
}

// A file-scope constant and an enum constant of the same name, in that order.
static constexpr uint64 Shared = 5;

namespace WithEnum
{
enum Kinds { Shared = 55 };
}

struct TwinEnum2
{
};

struct TwinEnum : public ContractBase
{
    struct StateData
    {
        uint64 alphaLow;
        uint64 alphaHigh;
        uint64 betaLow;
        uint64 betaHigh;
        uint64 product;
        uint64 controlFirst;
        uint64 controlSecond;
        uint64 fileConstant;
        uint64 enumConstant;
    };

    struct Snap_input
    {
    };

    struct Snap_output
    {
    };

    struct Snap_locals
    {
        uint64 scratch;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Snap)
    {
        locals.scratch = 1;
        state.mut().alphaLow = (uint64)Alpha::Low * locals.scratch;
        state.mut().alphaHigh = (uint64)Alpha::High * locals.scratch;
        state.mut().betaLow = (uint64)Beta::Low * locals.scratch;
        state.mut().betaHigh = (uint64)Beta::High * locals.scratch;
        state.mut().product = (uint64)Alpha::High * (uint64)Beta::Low;
        state.mut().controlFirst = (uint64)TwinName::Only;
        state.mut().controlSecond = (uint64)OtherName::Only;
        state.mut().fileConstant = Shared;
        state.mut().enumConstant = (uint64)WithEnum::Shared;
    }

    struct Read_input
    {
    };

    struct Read_output
    {
        uint64 alphaLow;
        uint64 alphaHigh;
        uint64 betaLow;
        uint64 betaHigh;
        uint64 product;
        uint64 controlFirst;
        uint64 controlSecond;
        uint64 fileConstant;
        uint64 enumConstant;
    };

    PUBLIC_FUNCTION(Read)
    {
        output.alphaLow = state.get().alphaLow;
        output.alphaHigh = state.get().alphaHigh;
        output.betaLow = state.get().betaLow;
        output.betaHigh = state.get().betaHigh;
        output.product = state.get().product;
        output.controlFirst = state.get().controlFirst;
        output.controlSecond = state.get().controlSecond;
        output.fileConstant = state.get().fileConstant;
        output.enumConstant = state.get().enumConstant;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Snap, 1);
    }

    INITIALIZE()
    {
        state.mut().alphaLow = 0;
        state.mut().alphaHigh = 0;
        state.mut().betaLow = 0;
        state.mut().betaHigh = 0;
        state.mut().product = 0;
        state.mut().controlFirst = 0;
        state.mut().controlSecond = 0;
        state.mut().fileConstant = 0;
        state.mut().enumConstant = 0;
    }
};
