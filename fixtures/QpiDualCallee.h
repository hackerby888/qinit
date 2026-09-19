// Companion contract for the deterministic compiler/runtime parity matrix.
using namespace QPI;

struct QpiDualCallee2 {};

struct QpiDualCallee : public ContractBase
{
    struct StateData
    {
        uint64 value;
        uint64 calls;
        uint64 initialized;
        uint64 rightsCallbacks;
        sint64 rightsFeesReceived;
        sint64 nestedReleaseReturn;
    };

    struct Add_input { uint64 amount; };
    struct Add_output { uint64 value; };
    struct FailAfterWrite_input
    {
        uint64 amount;
        sint64 divisor;
    };
    struct FailAfterWrite_output { sint64 quotient; };
    struct Read_input {};
    struct Read_output
    {
        uint64 value;
        uint64 calls;
        uint64 initialized;
    };
    struct FailRead_input { sint64 divisor; };
    struct FailRead_output { sint64 quotient; };
    struct Observe_input {};
    struct Observe_output
    {
        uint64 tick;
        uint64 epoch;
        id originator;
        id invocator;
    };
    struct Warp_input { uint64 ticks; };
    struct Warp_output {};

    INITIALIZE()
    {
        state.mut().value = 7;
        state.mut().initialized = 0x43414C4C45455741ull;
    }

    PUBLIC_PROCEDURE(Add)
    {
        state.mut().value += input.amount;
        state.mut().calls++;
        output.value = state.get().value;
    }

    PUBLIC_PROCEDURE(FailAfterWrite)
    {
        state.mut().value += input.amount;
        state.mut().calls++;
        output.quotient = div<sint64>(INT64_MIN, input.divisor);
    }

    PUBLIC_FUNCTION(Read)
    {
        output.value = state.get().value;
        output.calls = state.get().calls;
        output.initialized = state.get().initialized;
    }

    PUBLIC_FUNCTION(FailRead)
    {
        output.quotient = div<sint64>(INT64_MIN, input.divisor);
    }

    PUBLIC_FUNCTION(Observe)
    {
        output.tick = qpi.tick();
        output.epoch = qpi.epoch();
        output.originator = qpi.originator();
        output.invocator = qpi.invocator();
    }

    // leaves value and calls alone, so the matrix's expected callee words hold.
    PUBLIC_PROCEDURE(Warp)
    {
        CC_WARP_TICK(input.ticks);
    }

    // the driver releases management rights to this contract, then acquires them back; each leg asks a different fee.
    PRE_ACQUIRE_SHARES()
    {
        state.mut().rightsCallbacks++;
        output.allowTransfer = true;
        output.requestedFee = 5;
    }

    // the shares are under this contract's management here, so only the nesting guard stops it handing one back.
    POST_ACQUIRE_SHARES()
    {
        state.mut().rightsCallbacks++;
        state.mut().rightsFeesReceived += input.receivedFee;
        state.mut().nestedReleaseReturn =
            qpi.releaseShares(input.asset, input.owner, input.possessor, 1, input.otherContractIndex, input.otherContractIndex, 0);
    }

    PRE_RELEASE_SHARES()
    {
        state.mut().rightsCallbacks++;
        output.allowTransfer = true;
        output.requestedFee = 7;
    }

    POST_RELEASE_SHARES()
    {
        state.mut().rightsCallbacks++;
        state.mut().rightsFeesReceived += input.receivedFee;
    }

    struct Rights_input {};
    struct Rights_output
    {
        uint64 callbacks;
        sint64 feesReceived;
        sint64 nestedReleaseReturn;
    };

    PUBLIC_FUNCTION(Rights)
    {
        output.callbacks = state.get().rightsCallbacks;
        output.feesReceived = state.get().rightsFeesReceived;
        output.nestedReleaseReturn = state.get().nestedReleaseReturn;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Add, 1);
        REGISTER_USER_PROCEDURE(FailAfterWrite, 2);
        REGISTER_USER_FUNCTION(Read, 1);
        REGISTER_USER_FUNCTION(FailRead, 2);
        REGISTER_USER_PROCEDURE(Warp, 3);
        REGISTER_USER_FUNCTION(Observe, 3);
        REGISTER_USER_FUNCTION(Rights, 4);
    }
};
