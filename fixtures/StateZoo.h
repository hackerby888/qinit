// The shapes the core-lite system contracts keep in state, in one small contract: struct and
// nested-struct keys (Escrow, QIP), arrays and BitArrays as map values (Nostromo, QRaffle), bit and
// sub-word values (Quottery), signed keys, a Collection ordered by signed priority (Qx), a LinkedList,
// containers reached through structs, and structs with padding holes. Every procedure is deterministic
// in its input so a test can predict each value, and the functions report what the contract itself
// sees, which is what the readers are checked against.
using namespace QPI;

struct StateZoo2
{
};

struct StateZoo : public ContractBase
{
    struct Packed
    {
        uint8 tag;
        uint64 wide;
        uint16 half;
        id who;
        bit flag;
        sint8 tiny;
    };

    struct Sub
    {
        uint64 a;
        uint64 b;
    };

    // Four pad bytes follow `asset` and QPI hashes them with the fields, so a Key only matches when it
    // comes from zeroed memory, which both runtimes guarantee for locals.
    struct Key
    {
        Sub sub;
        uint32 asset;

        bool operator==(const Key& other) const
        {
            return sub.a == other.sub.a && sub.b == other.sub.b && asset == other.asset;
        }
    };

    struct Deep
    {
        Packed inner;
        Array<uint32, 4> quad;
    };

    struct Deeper
    {
        Deep deep;
        HashMap<uint64, uint64, 4> map;
    };

    struct OnlyContainers
    {
        HashMap<uint64, uint64, 4> a;
        HashSet<uint64, 4> b;
    };

    struct Order
    {
        id entity;
        sint64 amount;
        uint32 flags;
    };

    struct StateData
    {
        Packed packed;
        Deeper deeper;
        OnlyContainers only;
        Array<Array<uint16, 4>, 2> grid;
        Array<Packed, 4> packedArray;
        Array<BitArray<64>, 2> bitGrid;
        BitArray<1024> bits;
        HashMap<Key, uint64, 8> byKey;
        HashMap<id, Array<uint32, 4>, 4> arrayValues;
        HashMap<uint64, BitArray<64>, 4> bitValues;
        HashMap<uint64, bit, 4> bitFlags;
        HashMap<uint16, sint8, 4> smallKV;
        HashMap<sint64, Order, 4> signedKey;
        HashSet<uint8, 8> smallSet;
        HashSet<id, 4> idSet;
        HashSet<Key, 4> keySet;
        Collection<Order, 8> orders;
        LinkedList<sint64, 8> list;
        sint8 s8;
        sint16 s16;
        sint32 s32;
        sint64 s64;
        uint64 umax;
        id nullish;
    };

    struct Fill_input
    {
        uint64 seed;
        uint64 n;
    };
    struct Fill_output
    {
        uint64 population;
    };
    struct Fill_locals
    {
        uint64 i;
        Key key;
        Order order;
        Array<uint32, 4> quad;
        Array<uint16, 4> row;
        BitArray<64> word;
        BitArray<64> mask;
        id collider;
    };

    // Ids are id(3, i, 0, 0): QPI hashes an id by its first word, so every one targets slot 3 of a
    // four-slot container and the rest probe past the end back to slot 0.
    PUBLIC_PROCEDURE_WITH_LOCALS(Fill)
    {
        state.mut().s8 = -1;
        state.mut().s16 = -2;
        state.mut().s32 = -3;
        state.mut().s64 = -4;
        state.mut().umax = 0xFFFFFFFFFFFFFFFFULL;
        state.mut().packed.tag = 7;
        state.mut().packed.wide = input.seed;
        state.mut().packed.half = 513;
        state.mut().packed.who = qpi.invocator();
        state.mut().packed.flag = 1;
        state.mut().packed.tiny = -5;
        state.mut().deeper.deep.inner = state.get().packed;
        state.mut().packedArray.set(2, state.get().packed);
        locals.mask.set(63, true);
        state.mut().bitGrid.set(1, locals.mask);

        for (locals.i = 0; locals.i < input.n; locals.i++)
        {
            locals.key.sub.a = input.seed;
            locals.key.sub.b = locals.i;
            locals.key.asset = (uint32)locals.i;
            state.mut().byKey.set(locals.key, input.seed + locals.i);
            state.mut().keySet.add(locals.key);
            state.mut().deeper.map.set(locals.i, locals.i * 10);
            state.mut().only.a.set(locals.i, input.seed ^ locals.i);
            state.mut().only.b.add(locals.i);

            locals.quad.set(0, (uint32)locals.i);
            locals.quad.set(3, 99);
            locals.collider = id(3, locals.i, 0, 0);
            state.mut().arrayValues.set(locals.collider, locals.quad);
            state.mut().idSet.add(locals.collider);

            locals.word.set(locals.i, true);
            state.mut().bitValues.set(locals.i, locals.word);
            state.mut().bitFlags.set(locals.i, (locals.i & 1) == 1);
            state.mut().smallKV.set((uint16)locals.i, (sint8)(-(sint64)locals.i));
            state.mut().smallSet.add((uint8)(locals.i * 3));

            locals.order.entity = qpi.invocator();
            locals.order.amount = -(sint64)locals.i;
            locals.order.flags = 1;
            state.mut().orders.add(qpi.invocator(), locals.order, -(sint64)(locals.i * 100));
            state.mut().signedKey.set(-(sint64)locals.i - 1, locals.order);
            state.mut().list.addHead((sint64)locals.i);

            state.mut().bits.set(locals.i * 37 + 700, true);
            locals.row = state.get().grid.get(1);
            locals.row.set(2, (uint16)locals.i);
            state.mut().grid.set(1, locals.row);
        }

        output.population = state.get().byKey.population();
    }

    struct Update_input
    {
        uint64 seed;
        uint64 n;
    };
    struct Update_output
    {
    };
    struct Update_locals
    {
        uint64 i;
        Key key;
        Order order;
        Array<uint32, 4> quad;
    };

    // Existing keys get new values and nothing else moves.
    PUBLIC_PROCEDURE_WITH_LOCALS(Update)
    {
        for (locals.i = 0; locals.i < input.n; locals.i++)
        {
            locals.key.sub.a = input.seed;
            locals.key.sub.b = locals.i;
            locals.key.asset = (uint32)locals.i;
            state.mut().byKey.set(locals.key, input.seed * 1000 + locals.i);
            state.mut().deeper.map.set(locals.i, locals.i * 11);
            state.mut().only.a.set(locals.i, 5);
            locals.quad.set(1, (uint32)locals.i + 1);
            state.mut().arrayValues.set(id(3, locals.i, 0, 0), locals.quad);
            state.mut().bitFlags.set(locals.i, (locals.i & 1) == 0);
            state.mut().smallKV.set((uint16)locals.i, (sint8)(locals.i + 1));
            locals.order.entity = qpi.invocator();
            locals.order.amount = (sint64)input.seed;
            locals.order.flags = 2;
            state.mut().signedKey.set(-(sint64)locals.i - 1, locals.order);
        }
    }

    struct Churn_input
    {
        uint64 seed;
        uint64 key;
        sint64 orderIndex;
    };
    struct Churn_output
    {
        sint64 next;
    };
    struct Churn_locals
    {
        Key key;
        Order order;
    };

    // Removes one entry everywhere, the home-slot collider id(3, 0, 0, 0) included, so a later Cleanup
    // has to move id(3, 1, 0, 0) back into slot 3. The Collection removal moves its last element into
    // the hole.
    PUBLIC_PROCEDURE_WITH_LOCALS(Churn)
    {
        locals.key.sub.a = input.seed;
        locals.key.sub.b = input.key;
        locals.key.asset = (uint32)input.key;
        state.mut().byKey.removeByKey(locals.key);
        state.mut().keySet.remove(locals.key);
        state.mut().deeper.map.removeByKey(input.key);
        state.mut().only.a.removeByKey(input.key);
        state.mut().only.b.remove(input.key);
        state.mut().smallSet.remove((uint8)(input.key * 3));
        state.mut().smallKV.removeByKey((uint16)input.key);
        state.mut().bitFlags.removeByKey(input.key);
        state.mut().bitValues.removeByKey(input.key);
        state.mut().signedKey.removeByKey(-(sint64)input.key - 1);
        state.mut().idSet.remove(id(3, 0, 0, 0));
        state.mut().arrayValues.removeByKey(id(3, 0, 0, 0));

        output.next = state.mut().orders.remove(input.orderIndex);
        locals.order = state.get().orders.element(0);
        locals.order.amount = 777;
        state.mut().orders.replace(0, locals.order);
        state.mut().list.remove(state.get().list.headIndex());
    }

    struct Cleanup_input
    {
    };
    struct Cleanup_output
    {
    };

    PUBLIC_PROCEDURE(Cleanup)
    {
        state.mut().byKey.cleanup();
        state.mut().keySet.cleanup();
        state.mut().deeper.map.cleanupIfNeeded(0);
        state.mut().only.a.cleanup();
        state.mut().only.b.cleanup();
        state.mut().smallSet.cleanup();
        state.mut().smallKV.cleanup();
        state.mut().bitFlags.cleanup();
        state.mut().bitValues.cleanup();
        state.mut().signedKey.cleanup();
        state.mut().idSet.cleanup();
        state.mut().arrayValues.cleanup();
        state.mut().orders.cleanup();
    }

    struct Drain_input
    {
        uint64 seed;
        uint64 n;
    };
    struct Drain_output
    {
    };
    struct Drain_locals
    {
        uint64 i;
        Key key;
    };

    PUBLIC_PROCEDURE_WITH_LOCALS(Drain)
    {
        for (locals.i = 0; locals.i < input.n; locals.i++)
        {
            locals.key.sub.a = input.seed;
            locals.key.sub.b = locals.i;
            locals.key.asset = (uint32)locals.i;
            state.mut().byKey.removeByKey(locals.key);
            state.mut().keySet.remove(locals.key);
            state.mut().deeper.map.removeByKey(locals.i);
            state.mut().only.a.removeByKey(locals.i);
            state.mut().only.b.remove(locals.i);
            state.mut().smallSet.remove((uint8)(locals.i * 3));
            state.mut().smallKV.removeByKey((uint16)locals.i);
            state.mut().bitFlags.removeByKey(locals.i);
            state.mut().bitValues.removeByKey(locals.i);
            state.mut().signedKey.removeByKey(-(sint64)locals.i - 1);
            state.mut().idSet.remove(id(3, locals.i, 0, 0));
            state.mut().arrayValues.removeByKey(id(3, locals.i, 0, 0));
            state.mut().bits.set(locals.i * 37 + 700, false);
        }
        while (state.get().orders.population() > 0)
        {
            state.mut().orders.remove(0);
        }
        while (state.get().list.population() > 0)
        {
            state.mut().list.remove(state.get().list.headIndex());
        }
        state.mut().byKey.cleanup();
        state.mut().keySet.cleanup();
        state.mut().deeper.map.cleanup();
        state.mut().only.a.cleanup();
        state.mut().only.b.cleanup();
        state.mut().smallSet.cleanup();
        state.mut().smallKV.cleanup();
        state.mut().bitFlags.cleanup();
        state.mut().bitValues.cleanup();
        state.mut().signedKey.cleanup();
        state.mut().idSet.cleanup();
        state.mut().arrayValues.cleanup();
        state.mut().orders.cleanup();
    }

    struct Lookup_input
    {
        uint64 seed;
        uint64 i;
    };
    // `found` holds one bit per container, in the order of the fields below and then the three sets.
    struct Lookup_output
    {
        uint64 found;
        uint64 byKey;
        uint64 deeperMap;
        uint64 onlyA;
        Array<uint32, 4> arrayValue;
        BitArray<64> bitValue;
        bit bitFlag;
        sint8 smallKV;
        Order signedOrder;
    };
    struct Lookup_locals
    {
        Key key;
        id collider;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Lookup)
    {
        locals.key.sub.a = input.seed;
        locals.key.sub.b = input.i;
        locals.key.asset = (uint32)input.i;
        locals.collider = id(3, input.i, 0, 0);
        output.found = 0;
        if (state.get().byKey.get(locals.key, output.byKey))
        {
            output.found |= 1;
        }
        if (state.get().deeper.map.get(input.i, output.deeperMap))
        {
            output.found |= 2;
        }
        if (state.get().only.a.get(input.i, output.onlyA))
        {
            output.found |= 4;
        }
        if (state.get().arrayValues.get(locals.collider, output.arrayValue))
        {
            output.found |= 8;
        }
        if (state.get().bitValues.get(input.i, output.bitValue))
        {
            output.found |= 16;
        }
        if (state.get().bitFlags.get(input.i, output.bitFlag))
        {
            output.found |= 32;
        }
        if (state.get().smallKV.get((uint16)input.i, output.smallKV))
        {
            output.found |= 64;
        }
        if (state.get().signedKey.get(-(sint64)input.i - 1, output.signedOrder))
        {
            output.found |= 128;
        }
        if (state.get().only.b.contains(input.i))
        {
            output.found |= 256;
        }
        if (state.get().smallSet.contains((uint8)(input.i * 3)))
        {
            output.found |= 512;
        }
        if (state.get().idSet.contains(locals.collider))
        {
            output.found |= 1024;
        }
        if (state.get().keySet.contains(locals.key))
        {
            output.found |= 2048;
        }
    }

    struct Walk_input
    {
        id pov;
    };
    struct Walk_output
    {
        Array<sint64, 8> priorities;
        Array<sint64, 8> amounts;
        Array<sint64, 8> listValues;
        Array<uint64, 16> populations;
        uint64 orderCount;
        uint64 listCount;
    };
    struct Walk_locals
    {
        sint64 index;
        uint64 i;
    };

    // The Collection in the order the contract iterates it, the list from its head, and every count.
    PUBLIC_FUNCTION_WITH_LOCALS(Walk)
    {
        locals.index = state.get().orders.headIndex(input.pov);
        locals.i = 0;
        while (locals.index != NULL_INDEX && locals.i < 8)
        {
            output.priorities.set(locals.i, state.get().orders.priority(locals.index));
            output.amounts.set(locals.i, state.get().orders.element(locals.index).amount);
            locals.index = state.get().orders.nextElementIndex(locals.index);
            locals.i++;
        }
        output.orderCount = locals.i;

        locals.index = state.get().list.headIndex();
        locals.i = 0;
        while (locals.index != NULL_INDEX && locals.i < 8)
        {
            output.listValues.set(locals.i, state.get().list.element(locals.index));
            locals.index = state.get().list.nextElementIndex(locals.index);
            locals.i++;
        }
        output.listCount = locals.i;

        output.populations.set(0, state.get().byKey.population());
        output.populations.set(1, state.get().deeper.map.population());
        output.populations.set(2, state.get().only.a.population());
        output.populations.set(3, state.get().only.b.population());
        output.populations.set(4, state.get().arrayValues.population());
        output.populations.set(5, state.get().bitValues.population());
        output.populations.set(6, state.get().bitFlags.population());
        output.populations.set(7, state.get().smallKV.population());
        output.populations.set(8, state.get().signedKey.population());
        output.populations.set(9, state.get().smallSet.population());
        output.populations.set(10, state.get().idSet.population());
        output.populations.set(11, state.get().keySet.population());
        output.populations.set(12, state.get().orders.population());
        output.populations.set(13, state.get().list.population());
    }

    struct Dump_input
    {
    };
    struct Dump_output
    {
        uint64 count;
    };
    struct Dump_locals
    {
        sint64 index;
        uint64 i;
    };

    PUBLIC_FUNCTION_WITH_LOCALS(Dump)
    {
        CC_PRINT(state.get());
        CC_PRINT(state.get().byKey);
        CC_PRINT(state.get().arrayValues);
        CC_PRINT(state.get().bitValues);
        CC_PRINT(state.get().orders);
        CC_PRINT(state.get().list);
        CC_PRINT(state.get().deeper);
        CC_PRINT("s8", state.get().s8, "who", state.get().packed.who, "umax", state.get().umax);
        locals.index = state.get().orders.headIndex(state.get().packed.who);
        locals.i = 0;
        while (locals.index != NULL_INDEX)
        {
            CC_PRINT("order", state.get().orders.element(locals.index), "priority", state.get().orders.priority(locals.index));
            locals.index = state.get().orders.nextElementIndex(locals.index);
            locals.i++;
        }
        output.count = locals.i;
    }

    REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
    {
        REGISTER_USER_PROCEDURE(Fill, 1);
        REGISTER_USER_PROCEDURE(Update, 2);
        REGISTER_USER_PROCEDURE(Churn, 3);
        REGISTER_USER_PROCEDURE(Cleanup, 4);
        REGISTER_USER_PROCEDURE(Drain, 5);
        REGISTER_USER_FUNCTION(Lookup, 1);
        REGISTER_USER_FUNCTION(Walk, 2);
        REGISTER_USER_FUNCTION(Dump, 3);
    }
};
