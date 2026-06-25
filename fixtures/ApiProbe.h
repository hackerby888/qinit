// Surface probe: calls the qpi methods newly exposed to wasm (dayOfWeek, signatureValidity, the IPO + mining +
// oracle-status ops) so the build proves each lhost import resolves on the contract side.
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        sint64 acc;
    };

    struct Probe_input
    {
        uint8 year;
        uint8 month;
        uint8 day;
        sint64 queryId;
        uint32 ipoIdx;
        uint32 bidIdx;
    };
    struct Probe_output { sint64 result; };
    struct Probe_locals
    {
        id bidId;
        m256i mseed;
        m256i pk;
        m256i nonce;
        m256i mf;
    };

    struct Act_input
    {
        uint32 ipoIdx;
        sint64 price;
        uint32 qty;
        sint32 subId;
    };
    struct Act_output { sint64 result; };

    struct Verify_input
    {
        id entity;
        id digest;
        Array<sint8, 64> sig;
    };
    struct Verify_output { sint64 valid; };

    PUBLIC_FUNCTION_WITH_LOCALS(Probe)
    {
        output.result = qpi.dayOfWeek(input.year, input.month, input.day);
        output.result += qpi.ipoBidPrice(input.ipoIdx, input.bidIdx);
        output.result += qpi.getOracleQueryStatus(input.queryId);
        locals.bidId = qpi.ipoBidId(input.ipoIdx, input.bidIdx);
        locals.mf = qpi.computeMiningFunction(locals.mseed, locals.pk, locals.nonce);
        qpi.initMiningSeed(locals.mseed);
    }

    PUBLIC_FUNCTION(Verify)
    {
        output.valid = qpi.signatureValidity(input.entity, input.digest, input.sig) ? 1 : 0;
    }

    PUBLIC_PROCEDURE(Act)
    {
        output.result = qpi.bidInIPO(input.ipoIdx, input.price, input.qty);
        output.result += qpi.unsubscribeOracle(input.subId) ? 1 : 0;
        state.mut().acc = output.result;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Probe, 1);
        REGISTER_USER_FUNCTION(Verify, 2);
        REGISTER_USER_PROCEDURE(Act, 1);
    }
};
