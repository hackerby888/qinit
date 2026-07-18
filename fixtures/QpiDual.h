// Source-backed QPI dual-engine acceptance fixture. The TS compiler emits one
// artifact; CI runs those exact bytes in Sim and the release-configured WAMR node.
using namespace QPI;

struct QpiDualLowBitHash
{
    static uint64 hash(const uint64& key)
    {
        return key & 1ull;
    }
};

struct CONTRACT_STATE2_TYPE {};

struct CONTRACT_STATE_TYPE : public ContractBase
{
    struct StateData
    {
        HashMap<uint64, uint64, 32, QpiDualLowBitHash> values;
        HashSet<uint64, 32, QpiDualLowBitHash> seen;
        Collection<uint64, 32> queue;
        LinkedList<uint64, 16> list;
        uint128 wide;
        uint64 checksum;
        uint64 runs;
        uint64 initialized;
    };

    struct Run_input { uint64 seed; };
    struct Run_output {};
    struct Run_locals
    {
        id pov;
        uint128 a;
        uint128 b;
        uint64 i;
        uint64 value;
        sint64 index;
    };

    struct Read_input {};
    struct Read_output
    {
        uint64 checksum;
        uint64 mapPopulation;
        uint64 setPopulation;
        uint64 collectionPopulation;
        uint64 listPopulation;
        uint64 wideLow;
        uint64 wideHigh;
        uint64 runs;
        uint64 initialized;
    };

    INITIALIZE()
    {
        state.mut().initialized = 0x51494E4954574153ull;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Run)
    {
        state.mut().values.reset();
        state.mut().seen.reset();
        state.mut().queue.reset();
        state.mut().list.reset();
        state.mut().checksum = 0;
        locals.pov = id(input.seed, input.seed + 1, input.seed + 2, input.seed + 3);

        for (locals.i = 0; locals.i < 24; locals.i++)
        {
            state.mut().values.set(locals.i, input.seed + locals.i * 17);
            state.mut().seen.add(locals.i);
            state.mut().queue.add(locals.pov, input.seed ^ locals.i, (sint64)(locals.i * 3));
            if (locals.i < 12)
            {
                state.mut().list.addTail(input.seed + locals.i);
            }
        }

        for (locals.i = 0; locals.i < 8; locals.i++)
        {
            state.mut().values.removeByKey(locals.i * 2);
            state.mut().seen.remove(locals.i * 2);
            locals.index = state.get().queue.headIndex(locals.pov);
            if (locals.index >= 0)
            {
                state.mut().queue.remove(locals.index);
            }
        }
        state.mut().values.cleanupIfNeeded(0);
        state.mut().seen.cleanupIfNeeded(0);
        state.mut().queue.cleanupIfNeeded(0);

        locals.index = state.get().list.headIndex();
        if (locals.index >= 0)
        {
            state.mut().list.remove(locals.index);
        }
        locals.index = state.get().list.headIndex();
        if (locals.index >= 0)
        {
            state.mut().list.replace(locals.index, input.seed + 999);
        }

        locals.index = state.get().values.nextElementIndex(-1);
        while (locals.index >= 0)
        {
            state.mut().checksum += state.get().values.key(locals.index);
            state.mut().checksum += state.get().values.value(locals.index);
            locals.index = state.get().values.nextElementIndex(locals.index);
        }
        state.mut().checksum += state.get().seen.population();
        state.mut().checksum += state.get().queue.population(locals.pov);
        state.mut().checksum += state.get().list.population();

        locals.a = uint128(input.seed + 7, 0xfffffffffffffff0ull - input.seed);
        locals.b = uint128(0, (input.seed & 255ull) + 3);
        locals.a = ((locals.a * locals.b) + (uint128)17) << (uint128)5;
        state.mut().wide = div<uint128>(locals.a, locals.b);
        state.mut().checksum += state.get().wide.low;
        state.mut().checksum += state.get().wide.high;
        state.mut().checksum += QPI::smul(input.seed, 33ull);
        state.mut().checksum += QPI::sadd(input.seed, 44ull);
        state.mut().checksum += math_lib::max(input.seed, 55ull);
        state.mut().checksum += math_lib::min(input.seed, 66ull);
        state.mut().checksum += math_lib::irootK64<2>(input.seed * input.seed);

        state.mut().runs++;
    }

    PUBLIC_FUNCTION(Read)
    {
        output.checksum = state.get().checksum;
        output.mapPopulation = state.get().values.population();
        output.setPopulation = state.get().seen.population();
        output.collectionPopulation = state.get().queue.population();
        output.listPopulation = state.get().list.population();
        output.wideLow = state.get().wide.low;
        output.wideHigh = state.get().wide.high;
        output.runs = state.get().runs;
        output.initialized = state.get().initialized;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Run, 1);
        REGISTER_USER_FUNCTION(Read, 1);
    }
};
