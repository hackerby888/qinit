// Logging fixture: emits a contract LOG_INFO event from a procedure (tx-paired -> stored).
using namespace QPI;

// Log message kinds: the debugger resolves LogMsg._type back to these names.
enum LogKind { LogStarted = 0, LogValue = 1, LogDone = 2 };

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 count;
    };

    // Contract log message: first 4 bytes = contractIndex (host-set), last byte = _terminator.
    struct LogMsg { uint32 _contractIndex; uint32 _type; uint64 value; sint8 _terminator; };

    struct Emit_input { uint64 value; };
    struct Emit_output {};
    struct Emit_locals { LogMsg m; uint64 i; };
    struct Count_input {};
    struct Count_output { uint64 count; };

    PUBLIC_PROCEDURE_WITH_LOCALS(Emit)
    {
        locals.m._contractIndex = 0;
        locals.m._type = LogValue;
        locals.m._terminator = 0;
        for (locals.i = 0; locals.i < input.value; locals.i++) { locals.m.value = locals.i; LOG_INFO(locals.m); }
        state.mut().count += 1;
    }

    PUBLIC_FUNCTION(Count)
    {
        output.count = state.get().count;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Emit, 1);
        REGISTER_USER_FUNCTION(Count, 1);
    }

    INITIALIZE()
    {
        state.mut().count = 0;
    }
};
