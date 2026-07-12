// Cross-platform digest-equivalence probe. A mixed-width StateData (uint8/16/32/64 + sint64 + two arrays)
// set to fixed values in INITIALIZE, so the contract-state digest (K12 of the full effective state) covers a
using namespace QPI;

struct CONTRACT_STATE2_TYPE
{
};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        uint64 counter;
        uint8  a8;
        uint16 b16;
        uint32 c32;
        sint64 d64;
        Array<uint64, 4> quads;
        Array<uint8, 8>  bytes;
    };

    struct Inc_input {};
    struct Inc_output {};
    struct Get_input {};
    struct Get_output { uint64 value; };

    PUBLIC_PROCEDURE(Inc)
    {
        state.mut().counter += 1;
    }

    PUBLIC_FUNCTION(Get)
    {
        output.value = state.get().counter;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Inc, 1);
        REGISTER_USER_FUNCTION(Get, 1);
    }

    INITIALIZE()
    {
        state.mut().a8  = 0xA5;
        state.mut().b16 = 0x1234;
        state.mut().c32 = 0xDEADBEEF;
        state.mut().d64 = -123456789012345;
        state.mut().quads.set(0, 0x0102030405060708ULL);
        state.mut().quads.set(1, 0x1112131415161718ULL);
        state.mut().quads.set(2, 0x2122232425262728ULL);
        state.mut().quads.set(3, 0x3132333435363738ULL);
        state.mut().bytes.set(0, 0x11);
        state.mut().bytes.set(3, 0x44);
        state.mut().bytes.set(7, 0x88);
    }
};
