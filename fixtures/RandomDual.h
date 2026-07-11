// Chain-seeded PRNG dual-engine fixture. The procedure records the exact chain
// digest used by its dispatch so the same call can be replayed under Sim.
using namespace QPI;

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        id prevSpectrum;
        id first;
        id second;
        id third;
        uint16 r16;
        uint16 guard16;
        uint32 r32;
        uint32 guard32;
        uint64 r64;
        uint64 guard64;
        uint32 success16;
        uint32 success32;
        uint32 success64;
        uint64 runs;
    };

    struct Run_input { uint64 nonce; };
    struct Run_output {};

    PUBLIC_PROCEDURE(Run)
    {
        state.mut().prevSpectrum = qpi.getPrevSpectrumDigest();
        state.mut().guard16 = 0xa55au;
        state.mut().guard32 = 0x5aa55aa5u;
        state.mut().guard64 = 0x0123456789abcdefull;
        state.mut().success16 = _rdrand16_step(reinterpret_cast<unsigned short*>(&state.mut().r16));
        state.mut().success32 = _rdrand32_step(reinterpret_cast<unsigned int*>(&state.mut().r32));
        state.mut().success64 = _rdrand64_step(reinterpret_cast<unsigned long long*>(&state.mut().r64));
        state.mut().first = id::randomValue();
        state.mut().second = m256i::randomValue();
        state.mut().third.setRandomValue();
        state.mut().runs += input.nonce;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Run, 1);
    }
};
