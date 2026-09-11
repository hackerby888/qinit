// Minimal repro for F201: the TypeScript backend rejects a member read through a base class reached by
// an alias-of-alias-of-alias typedef, which clang accepts. Reduced from
// corpus/solidity-port/variants/namespaces/NsInheritedNamespacedTypedef__7ee1.h.
//
// The three bases are the finding and its two controls, all in one contract so one build decides all of
// them: `Direct` inherits the struct itself, `OneAlias` inherits through a single typedef (both accepted
// by the TypeScript backend), and `ThreeAliases` inherits through a chain of three (rejected).
using namespace QPI;

namespace Port
{
struct Base
{
    uint64 a;
    uint64 b;
    uint64 c;
};
using BaseA = Base;
using BaseB = BaseA;
using BaseC = BaseB;
}

struct Direct : public Port::Base
{
    uint64 d;
};

struct OneAlias : public Port::BaseA
{
    uint64 d;
};

struct ThreeAliases : public Port::BaseC
{
    uint64 d;
};

struct AliasBase2
{
};

struct AliasBase : public ContractBase
{
    struct StateData
    {
        Direct direct;
        OneAlias oneAlias;
        ThreeAliases threeAliases;
    };

    struct Write_input
    {
        uint64 value;
    };
    struct Write_output {};
    struct Write_locals
    {
        uint64 scratch;
    };

    struct Read_input {};
    struct Read_output
    {
        uint64 fromDirect;
        uint64 fromOneAlias;
        uint64 fromThreeAliases;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Write)
    {
        locals.scratch = input.value;
        state.mut().direct.a = locals.scratch;
        state.mut().oneAlias.a = locals.scratch;
        state.mut().threeAliases.a = locals.scratch;
    }

    PUBLIC_FUNCTION(Read)
    {
        // Control rows: both of these member reads are accepted by both backends.
        output.fromDirect = state.get().direct.a;
        output.fromOneAlias = state.get().oneAlias.a;
        // The finding: the same read through a three-deep alias chain is rejected by the
        // TypeScript backend with "unsupported member read".
        output.fromThreeAliases = state.get().threeAliases.a;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Write, 1);
    }

    INITIALIZE()
    {
        state.mut().direct.a = 0;
        state.mut().oneAlias.a = 0;
        state.mut().threeAliases.a = 0;
    }
};
