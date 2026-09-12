using namespace QPI;

struct Meter2
{
};

// The document the editing-session campaign mutates: renamed, de-classified, re-registered and
// restored, with every intermediate state asserted rather than only the endpoints.
struct Meter : public ContractBase
{
    struct Reading
    {
        uint64 tick;
        BitArray<8> flags;
    };

    struct StateData
    {
        uint64 calls;
        Reading last;
        Array<Reading, 4> history;
    };

    struct Poll_input
    {
        uint64 index;
    };
    struct Poll_output
    {
        uint64 tick;
    };
    struct Poll_locals
    {
        Reading scratch;
        Feed::Read_input in;
        Feed::Read_output out;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Poll)
    {
        locals.scratch.tick = state.get().last.tick;
        locals.scratch.flags.setAll(0);
        locals.in.index = input.index;
        CALL_OTHER_CONTRACT_FUNCTION(Feed, Read, locals.in, locals.out);
        output.tick = locals.scratch.tick + locals.out.sample.value;
    }

    struct Bump_input
    {
    };
    struct Bump_output
    {
    };

    PUBLIC_PROCEDURE(Bump)
    {
        state.mut().calls += 1;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_FUNCTION(Poll, 1);
        REGISTER_USER_PROCEDURE(Bump, 2);
    }
};
