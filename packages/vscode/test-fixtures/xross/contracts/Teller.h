using namespace QPI;

struct Teller2
{
};

// The caller. Every line in Read is a receiver the completion matrix probes; the `direct` locals are
// controls that name a callee's nested type qualified, which is the spelling that already resolves.
struct Teller : public ContractBase
{
    struct StateData
    {
        uint64 calls;
        Bank::Tier mirror;
        Array<Bank::Lot, 4> book;
    };

    struct Read_input
    {
    };
    struct Read_output
    {
        uint64 value;
    };
    struct Read_locals
    {
        Bank::Quote_input in;
        Bank::Quote_output out;
        Bank::Tier direct;
        Bank::Tranche directTranche;
        Ledger::Entry directEntry;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Read)
    {
        locals.in.hist.setAll(0);
        locals.in.tranche.tier.rank = 0;
        locals.in.tranche.hist.setAll(0);
        locals.in.tranche.flags = 0;
        locals.in.tranche.tier.bits.setAll(0);
        locals.in.key.a = 0;
        locals.in.lots.setAll(locals.out.lot);
        locals.in.grid.setAll(locals.in.tranche.tier.bits);
        locals.in.flags.setAll(0);
        locals.in.stamp.at = 0;
        locals.in.offset = 0;

        locals.direct.rank = 0;
        locals.directTranche.tier.rank = 0;
        locals.directEntry.stamp.at = 0;

        CALL_OTHER_CONTRACT_FUNCTION(Bank, Quote, locals.in, locals.out);

        output.value = locals.out.lot.qty + locals.out.tier.rank + locals.out.lot.tier.rank + state.get().calls + state.get().mirror.rank;
    }

    struct Post_input
    {
    };
    struct Post_output
    {
        uint64 seq;
    };
    struct Post_locals
    {
        Ledger::Note_input note;
        Ledger::Note_output noteOut;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Post)
    {
        locals.note.entry.stamp.at = 0;
        locals.note.entry.amounts.setAll(0);
        CALL_OTHER_CONTRACT_FUNCTION(Ledger, Note, locals.note, locals.noteOut);
        output.seq = locals.noteOut.seq;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_FUNCTION(Post, 2);
    }
};
