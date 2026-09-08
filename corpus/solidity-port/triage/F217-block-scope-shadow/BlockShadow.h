// Minimal repro for F217: a block-scope local shadowing an outer name is refused by the TypeScript
// backend and accepted by clang. Reduced from corpus/solidity-port/variants/namespaces/
// NsBlockScopeShadowChain__base.h.
//
// clang compiles this and returns the C++ answer — 1, 20, 300, 1 — confirmed byte-identically on
// core's own WAMR host. The TypeScript backend refuses the contract with two diagnostics:
//
//   error: 'tier' is used before its declaration (or outside the scope that declares it)
//   error: 'tier' shadows a declaration in an enclosing scope — locals share one slot per name,
//          so shadowing is not supported
//
// The second names the cause: the backend's locals model is flat, one slot per name per entry, so a
// block cannot introduce its own binding. The first is the more interesting one — `atOne = tier` is
// read BEFORE any block declares a local `tier`, so in C++ it unambiguously reads the file-scope
// constant. Calling that a use-before-declaration means the block-local declaration is being hoisted
// over the whole entry body, which is what C99 block scoping exists to prevent.
//
// `afterBlocks` is the control: the same bare `tier`, read after both blocks have closed, which must
// be the file-scope constant again. clang returns 1 for it.
using namespace QPI;

static constexpr uint64 tier = 1;

struct BlockShadow2
{
};

struct BlockShadow : public ContractBase
{
    struct StateData
    {
        uint64 outer;
        uint64 depthOne;
        uint64 depthTwo;
        uint64 afterAll;
        uint64 calls;
    };

    struct Snap_input
    {
        uint64 seed;
    };
    struct Snap_output {};
    struct Snap_locals
    {
        uint64 atOne;
        uint64 atTwo;
        uint64 atThree;
        uint64 afterBlocks;
    };

    struct Read_input {};
    struct Read_output
    {
        uint64 outer;
        uint64 depthOne;
        uint64 depthTwo;
        uint64 afterAll;
        uint64 calls;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Snap)
    {
        locals.atOne = tier;              // the file-scope constant: no local `tier` is in scope yet
        {
            uint64 tier = 20;
            locals.atTwo = tier;          // the inner block's own binding
            {
                uint64 tier = 300;
                locals.atThree = tier;    // the innermost binding
            }
        }
        locals.afterBlocks = tier;        // control: the file-scope constant again
        state.mut().outer = locals.atOne;
        state.mut().depthOne = locals.atTwo;
        state.mut().depthTwo = locals.atThree;
        state.mut().afterAll = locals.afterBlocks;
        state.mut().calls++;
    }

    PUBLIC_FUNCTION(Read)
    {
        output.outer = state.get().outer;
        output.depthOne = state.get().depthOne;
        output.depthTwo = state.get().depthTwo;
        output.afterAll = state.get().afterAll;
        output.calls = state.get().calls;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Snap, 1);
    }

    INITIALIZE()
    {
        state.mut().outer = 0;
        state.mut().depthOne = 0;
        state.mut().depthTwo = 0;
        state.mut().afterAll = 0;
        state.mut().calls = 0;
    }
};
