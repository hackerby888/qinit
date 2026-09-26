// reads QX's fees into its own state and burns qu through QUTIL: a user contract typed by two system contracts.
using namespace QPI;

struct SysProbe2
{
};

struct SysProbe : public ContractBase
{
    struct StateData
    {
        QX::Fees_output lastFees;
        sint64 burned;
        uint64 reads;
    };

    struct ReadFees_input {};
    struct ReadFees_output { uint64 issuance; uint64 transfer; uint64 trade; };
    struct RefreshFees_input {};
    struct RefreshFees_output { uint64 reads; };
    struct Burn_input { sint64 amount; };
    struct Burn_output { sint64 burned; };

    struct ReadFees_locals { QX::Fees_input fi; QX::Fees_output fo; };
    PUBLIC_FUNCTION_WITH_LOCALS(ReadFees)
    {
        CALL_OTHER_CONTRACT_FUNCTION(QX, Fees, locals.fi, locals.fo);
        output.issuance = locals.fo.assetIssuanceFee;
        output.transfer = locals.fo.transferFee;
        output.trade = locals.fo.tradeFee;
    }

    struct RefreshFees_locals { QX::Fees_input fi; };
    PUBLIC_PROCEDURE_WITH_LOCALS(RefreshFees)
    {
        CALL_OTHER_CONTRACT_FUNCTION(QX, Fees, locals.fi, state.mut().lastFees);
        state.mut().reads += 1;
        output.reads = state.get().reads;
    }

    struct Burn_locals { QUTIL::BurnQubic_input bi; QUTIL::BurnQubic_output bo; };
    PUBLIC_PROCEDURE_WITH_LOCALS(Burn)
    {
        locals.bi.amount = input.amount;
        INVOKE_OTHER_CONTRACT_PROCEDURE(QUTIL, BurnQubic, locals.bi, locals.bo, input.amount);
        state.mut().burned += locals.bo.amount;
        output.burned = state.get().burned;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(ReadFees, 1);
        REGISTER_USER_PROCEDURE(RefreshFees, 1);
        REGISTER_USER_PROCEDURE(Burn, 2);
    }

    INITIALIZE()
    {
        state.mut().burned = 0;
        state.mut().reads = 0;
    }
};
