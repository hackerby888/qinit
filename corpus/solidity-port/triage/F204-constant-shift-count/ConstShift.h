// Minimal repro for F204: a shift by a count >= the operand width diverges between the two backends when
// the count is a compile-time constant, and agrees when the same count arrives at runtime. Reduced from
// corpus/solidity-port/variants/integers/ShiftRhsWiderThanLhs__5bf5.h.
//
// Shifting by >= the operand's width is undefined in C++ (and defined as 0 in Solidity, which is where
// the archetype came from), so neither answer is "wrong" in the language's terms. What the rows below
// pin down is narrower and actionable: the two backends agree on every runtime spelling and disagree
// only on the folded one, so the divergence lives in constant folding rather than in shift codegen.
using namespace QPI;

static constexpr uint8 FOLDED_COUNT = 254;
static constexpr uint8 FOLDED_IN_RANGE = 3;

struct ConstShift2
{
};

struct ConstShift : public ContractBase
{
    struct StateData
    {
        uint64 foldedOutOfRange;
        uint64 runtimeOutOfRange;
        uint64 foldedInRange;
        uint64 runtimeInRange;
        uint64 agreeOutOfRange;
        uint64 agreeInRange;
    };

    struct Shift_input
    {
        uint64 value;
        uint8 count;
    };
    struct Shift_output {};
    struct Shift_locals
    {
        uint64 scratch;
    };

    struct Read_input {};
    struct Read_output
    {
        uint64 foldedOutOfRange;
        uint64 runtimeOutOfRange;
        uint64 foldedInRange;
        uint64 runtimeInRange;
        uint64 agreeOutOfRange;
        uint64 agreeInRange;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Shift)
    {
        // The finding: the count is a constant the compiler may fold, and it exceeds the width.
        locals.scratch = input.value << FOLDED_COUNT;
        state.mut().foldedOutOfRange = locals.scratch;

        // The control: the identical count arrives at runtime, so nothing can be folded.
        locals.scratch = input.value << input.count;
        state.mut().runtimeOutOfRange = locals.scratch;

        // Second control pair, with a count inside the width: folded and runtime must both agree.
        locals.scratch = input.value << FOLDED_IN_RANGE;
        state.mut().foldedInRange = locals.scratch;
        locals.scratch = input.value << (uint8)3;
        state.mut().runtimeInRange = locals.scratch;

        state.mut().agreeOutOfRange = (state.get().foldedOutOfRange == state.get().runtimeOutOfRange) ? 1 : 0;
        state.mut().agreeInRange = (state.get().foldedInRange == state.get().runtimeInRange) ? 1 : 0;
    }

    PUBLIC_FUNCTION(Read)
    {
        output.foldedOutOfRange = state.get().foldedOutOfRange;
        output.runtimeOutOfRange = state.get().runtimeOutOfRange;
        output.foldedInRange = state.get().foldedInRange;
        output.runtimeInRange = state.get().runtimeInRange;
        output.agreeOutOfRange = state.get().agreeOutOfRange;
        output.agreeInRange = state.get().agreeInRange;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Shift, 1);
    }

    INITIALIZE()
    {
    }
};
