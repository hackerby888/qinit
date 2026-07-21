// Deterministic compiler/runtime parity driver. The same source is compiled by
// Qinit and Clang, then deployed to the virtual node and core-lite.
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
        Array<uint64, 8> arrayValues;
        BitArray<128> bits;
        HashMap<uint64, uint64, 32, QpiDualLowBitHash> values;
        HashSet<uint64, 32, QpiDualLowBitHash> seen;
        Collection<uint64, 32> queue;
        LinkedList<uint64, 16> list;
        uint128 wide;
        id hash;
        uint64 checksum;
        uint64 flags;
        uint64 pitCount;
        uint64 calleeValue;
        uint64 calleeCalls;
        uint64 runs;
        uint64 initialized;
    };

    struct CalleeRead_input {};
    struct CalleeRead_output
    {
        uint64 value;
        uint64 calls;
        uint64 initialized;
    };
    struct CalleeAdd_input { uint64 amount; };
    struct CalleeAdd_output { uint64 value; };

    struct Run_input
    {
        uint64 seed;
        uint64 expectedSelfIndex;
    };
    struct Run_output {};
    struct Run_locals
    {
        id expectedSelf;
        id pov;
        uint128 a;
        uint128 b;
        uint64 i;
        uint64 j;
        uint64 key;
        uint64 value;
        uint64 valid;
        uint64 rootValue;
        uint64 root;
        uint64 rootBit;
        sint64 index;
        CalleeRead_input readInput;
        CalleeRead_output before;
        CalleeRead_output after;
        CalleeAdd_input addInput;
        CalleeAdd_output addOutput;
    };

    struct Read_input {};
    struct Read_output
    {
        uint64 checksum;
        uint64 flags;
        uint64 pitCount;
        uint64 mapPopulation;
        uint64 setPopulation;
        uint64 collectionPopulation;
        uint64 listPopulation;
        uint64 calleeValue;
        uint64 calleeCalls;
        uint64 runs;
        uint64 initialized;
    };

    INITIALIZE()
    {
        state.mut().initialized = 0x51494E4954574153ull;
    }

    POST_INCOMING_TRANSFER()
    {
        state.mut().pitCount++;
    }

    PUBLIC_PROCEDURE_WITH_LOCALS(Run)
    {
        state.mut().arrayValues.setAll(input.seed);
        state.mut().arrayValues.set(input.seed & 7, input.seed + 99);
        state.mut().bits.setAll(false);
        state.mut().bits.set(input.seed & 127, true);
        state.mut().bits.set((input.seed + 65) & 127, true);
        state.mut().values.reset();
        state.mut().seen.reset();
        state.mut().queue.reset();
        state.mut().list.reset();
        state.mut().checksum = 0;
        state.mut().flags = 0;

        locals.expectedSelf = id(input.expectedSelfIndex, 0, 0, 0);
        if (SELF_INDEX == input.expectedSelfIndex)
        {
            state.mut().flags |= 1;
        }
        if (SELF == locals.expectedSelf)
        {
            state.mut().flags |= 2;
        }
        if (qpi.invocator() != NULL_ID && qpi.invocationReward() == 2)
        {
            state.mut().flags |= 4;
        }

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

        locals.valid = 1;
        if (state.get().values.population() != 16 || state.get().seen.population() != 16)
        {
            locals.valid = 0;
        }
        locals.j = 0;
        locals.index = state.get().values.nextElementIndex(-1);
        while (locals.index >= 0)
        {
            locals.value = state.get().values.key(locals.index);
            if (locals.value >= 24
                || (locals.value < 16 && (locals.value & 1) == 0)
                || state.get().values.value(locals.index) != input.seed + locals.value * 17)
            {
                locals.valid = 0;
            }
            locals.j++;
            locals.index = state.get().values.nextElementIndex(locals.index);
        }
        if (locals.j != 16)
        {
            locals.valid = 0;
        }
        locals.j = 0;
        locals.index = state.get().seen.nextElementIndex(-1);
        while (locals.index >= 0)
        {
            locals.value = state.get().seen.key(locals.index);
            if (locals.value >= 24 || (locals.value < 16 && (locals.value & 1) == 0))
            {
                locals.valid = 0;
            }
            locals.j++;
            locals.index = state.get().seen.nextElementIndex(locals.index);
        }
        if (locals.j != 16)
        {
            locals.valid = 0;
        }
        if (locals.valid)
        {
            state.mut().flags |= 8;
        }

        locals.valid = 1;
        for (locals.i = 0; locals.i < 128; locals.i++)
        {
            locals.key = ((locals.i & 7) << 1) + 1;
            if (state.mut().values.removeByKey(locals.key) < 0
                || state.mut().seen.remove(locals.key) < 0)
            {
                locals.valid = 0;
            }
            if (locals.i & 1)
            {
                state.mut().values.cleanup();
                state.mut().seen.cleanup();
            }
            else
            {
                state.mut().seen.cleanup();
                state.mut().values.cleanup();
            }
            if (state.get().values.population() != 15 || state.get().seen.population() != 15)
            {
                locals.valid = 0;
            }
            locals.j = 0;
            locals.index = state.get().values.nextElementIndex(-1);
            while (locals.index >= 0)
            {
                locals.value = state.get().values.key(locals.index);
                if (locals.value >= 24
                    || (locals.value < 16 && (locals.value & 1) == 0)
                    || locals.value == locals.key
                    || state.get().values.value(locals.index) != input.seed + locals.value * 17)
                {
                    locals.valid = 0;
                }
                locals.j++;
                locals.index = state.get().values.nextElementIndex(locals.index);
            }
            if (locals.j != 15)
            {
                locals.valid = 0;
            }
            locals.j = 0;
            locals.index = state.get().seen.nextElementIndex(-1);
            while (locals.index >= 0)
            {
                locals.value = state.get().seen.key(locals.index);
                if (locals.value >= 24
                    || (locals.value < 16 && (locals.value & 1) == 0)
                    || locals.value == locals.key)
                {
                    locals.valid = 0;
                }
                locals.j++;
                locals.index = state.get().seen.nextElementIndex(locals.index);
            }
            if (locals.j != 15)
            {
                locals.valid = 0;
            }
            if (state.mut().values.set(locals.key, input.seed + locals.key * 17) < 0
                || state.mut().seen.add(locals.key) < 0
                || state.get().values.population() != 16
                || state.get().seen.population() != 16)
            {
                locals.valid = 0;
            }
            locals.j = 0;
            locals.index = state.get().values.nextElementIndex(-1);
            while (locals.index >= 0)
            {
                locals.value = state.get().values.key(locals.index);
                if (locals.value >= 24
                    || (locals.value < 16 && (locals.value & 1) == 0)
                    || state.get().values.value(locals.index) != input.seed + locals.value * 17)
                {
                    locals.valid = 0;
                }
                locals.j++;
                locals.index = state.get().values.nextElementIndex(locals.index);
            }
            if (locals.j != 16)
            {
                locals.valid = 0;
            }
            locals.j = 0;
            locals.index = state.get().seen.nextElementIndex(-1);
            while (locals.index >= 0)
            {
                locals.value = state.get().seen.key(locals.index);
                if (locals.value >= 24 || (locals.value < 16 && (locals.value & 1) == 0))
                {
                    locals.valid = 0;
                }
                locals.j++;
                locals.index = state.get().seen.nextElementIndex(locals.index);
            }
            if (locals.j != 16)
            {
                locals.valid = 0;
            }
        }
        if (locals.valid)
        {
            state.mut().flags |= 16;
        }

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

        {
            CALL_OTHER_CONTRACT_FUNCTION(
                QpiDualCallee,
                Read,
                locals.readInput,
                locals.before);
        }
        locals.addInput.amount = input.seed & 255;
        {
            INVOKE_OTHER_CONTRACT_PROCEDURE(
                QpiDualCallee,
                Add,
                locals.addInput,
                locals.addOutput,
                0);
        }
        {
            CALL_OTHER_CONTRACT_FUNCTION(
                QpiDualCallee,
                Read,
                locals.readInput,
                locals.after);
        }
        if (locals.before.initialized == 0x43414C4C45455741ull
            && locals.after.calls == locals.before.calls + 1
            && locals.after.value == locals.before.value + locals.addInput.amount
            && locals.addOutput.value == locals.after.value)
        {
            state.mut().flags |= 32;
        }
        state.mut().calleeValue = locals.after.value;
        state.mut().calleeCalls = locals.after.calls;

        locals.a = uint128(input.seed + 7, 0xfffffffffffffff0ull - input.seed);
        locals.b = uint128(0, (input.seed & 255ull) + 3);
        locals.a = ((locals.a * locals.b) + (uint128)17) << (uint128)5;
        state.mut().wide = div<uint128>(locals.a, locals.b);
        state.mut().hash = qpi.K12(input.seed);

        locals.index = state.get().values.nextElementIndex(-1);
        while (locals.index >= 0)
        {
            state.mut().checksum += state.get().values.key(locals.index);
            state.mut().checksum += state.get().values.value(locals.index);
            locals.index = state.get().values.nextElementIndex(locals.index);
        }
        state.mut().checksum += state.get().arrayValues.get(input.seed & 7);
        state.mut().checksum += state.get().bits.get(input.seed & 127) ? 1 : 0;
        state.mut().checksum += state.get().seen.population();
        state.mut().checksum += state.get().queue.population(locals.pov);
        state.mut().checksum += state.get().list.population();
        state.mut().checksum += state.get().wide.low;
        state.mut().checksum += state.get().wide.high;
        state.mut().checksum += QPI::smul(input.seed, 33ull);
        state.mut().checksum += QPI::sadd(input.seed, 44ull);
        state.mut().checksum += input.seed > 55ull ? input.seed : 55ull;
        state.mut().checksum += input.seed < 66ull ? input.seed : 66ull;
        locals.rootValue = input.seed * input.seed;
        locals.root = 0;
        locals.rootBit = 1ull << 62;
        while (locals.rootBit > locals.rootValue)
        {
            locals.rootBit >>= 2;
        }
        while (locals.rootBit != 0)
        {
            if (locals.rootValue >= locals.root + locals.rootBit)
            {
                locals.rootValue -= locals.root + locals.rootBit;
                locals.root = (locals.root >> 1) + locals.rootBit;
            }
            else
            {
                locals.root >>= 1;
            }
            locals.rootBit >>= 2;
        }
        state.mut().checksum += locals.root;
        state.mut().checksum += state.get().calleeValue;

        qpi.transfer(locals.pov, 1);
        state.mut().runs++;
    }

    PUBLIC_FUNCTION(Read)
    {
        output.checksum = state.get().checksum;
        output.flags = state.get().flags;
        output.pitCount = state.get().pitCount;
        output.mapPopulation = state.get().values.population();
        output.setPopulation = state.get().seen.population();
        output.collectionPopulation = state.get().queue.population();
        output.listPopulation = state.get().list.population();
        output.calleeValue = state.get().calleeValue;
        output.calleeCalls = state.get().calleeCalls;
        output.runs = state.get().runs;
        output.initialized = state.get().initialized;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Run, 1);
        REGISTER_USER_FUNCTION(Read, 1);
    }
};
