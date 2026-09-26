// Outsourced-computation fixture shared by the TS/Clang and VirtualNode/WAMR parity tests.
using namespace QPI;

struct OcProbe2
{
};

struct OcProbe : public ContractBase
{
    struct StateData
    {
        sint64 invocationId;
        uint64 invocations;
    };

    struct Invoke_input
    {
        uint64 value;
    };
    struct Invoke_output
    {
        sint64 invocationId;
    };
    struct Invoke_locals
    {
        OCI::Mock::OcRequest request;
    };

    struct Status_input
    {
        sint64 invocationId;
    };
    struct Status_output
    {
        uint64 status;
    };

    struct Last_input
    {
    };
    struct Last_output
    {
        sint64 invocationId;
        uint64 invocations;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Invoke)
    {
        // the request is hashed for consensus including its padding, so it is zeroed before any field is set.
        setMemory(locals.request, 0);
        locals.request.value = input.value;
        output.invocationId = INVOKE_OC(OCI::Mock, locals.request);
        state.mut().invocationId = output.invocationId;
        if (output.invocationId >= 0)
        {
            state.mut().invocations++;
        }
    }

    PUBLIC_FUNCTION(Status)
    {
        output.status = qpi.getOcInvocationStatus(input.invocationId);
    }

    PUBLIC_FUNCTION(Last)
    {
        output.invocationId = state.get().invocationId;
        output.invocations = state.get().invocations;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Invoke, 2);
        REGISTER_USER_FUNCTION(Last, 1);
        REGISTER_USER_FUNCTION(Status, 2);
    }
};
