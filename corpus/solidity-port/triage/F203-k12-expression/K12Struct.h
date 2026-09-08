// Minimal repro for F203: `qpi.K12(<expression>)` hashes different bytes under the two backends, while
// `qpi.K12(<variable>)` agrees. Reduced from
// corpus/solidity-port/variants/containers/MerkleProofIterativeVerify__base.h, whose Merkle fold hashes
// `input.seed + i`.
//
// core's K12 is one line (src/qpi/impl/qpi_trivial_impl.h:111):
//     KangarooTwelve(&data, sizeof(data), &digest, sizeof(digest));
// The template binds `const T&`, so an argument that is a temporary must still hash exactly the 8 bytes
// of the uint64 it computed. The four rows are: a plain member (control), a local holding the same value
// (control), and the same value written as two different expressions (the finding).
using namespace QPI;

struct K12Struct2
{
};

struct K12Struct : public ContractBase
{
    struct StateData
    {
        id ofMember;
        id ofLocal;
        id ofSumExpression;
        id ofProductExpression;
        uint64 witness;
    };

    struct Hash_input
    {
        uint64 a;
        uint64 b;
    };
    struct Hash_output {};
    struct Hash_locals
    {
        uint64 sum;
    };

    struct Read_input {};
    struct Read_output
    {
        id ofMember;
        id ofLocal;
        id ofSumExpression;
        id ofProductExpression;
        uint64 witness;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Hash)
    {
        // Control 1: the argument is a plain member access.
        state.mut().ofMember = qpi.K12(input.a);

        // Control 2: the same value through a named local. Must equal the expression rows below,
        // because `a + b` and `sum` hold identical bytes.
        locals.sum = input.a + input.b;
        state.mut().ofLocal = qpi.K12(locals.sum);
        state.mut().witness = locals.sum;

        // The finding: the same value passed as a computed expression.
        state.mut().ofSumExpression = qpi.K12(input.a + input.b);
        state.mut().ofProductExpression = qpi.K12(input.a * 1);
    }

    PUBLIC_FUNCTION(Read)
    {
        output.ofMember = state.get().ofMember;
        output.ofLocal = state.get().ofLocal;
        output.ofSumExpression = state.get().ofSumExpression;
        output.ofProductExpression = state.get().ofProductExpression;
        output.witness = state.get().witness;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_PROCEDURE(Hash, 1);
    }

    INITIALIZE()
    {
        state.mut().witness = 0;
    }
};
