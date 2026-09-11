// Data structures a contract builds *on top of* the QPI containers: queues, stacks, ring buffers, index maps, checkpoints and a small LRU. Ported from
// OpenZeppelin's `structs/*` and `Checkpoints.sol` and from the hand-rolled queues every auction and payout contract carries.

import { emitContract } from "../emit";
import { capacityOf, fillCount } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";
const OZ = "openzeppelin-contracts/contracts/utils/structs";

interface PatternSpec {
    /** StateData members, containers included. */
    state: string;
    /** Entries beyond the standard `Read`; the first is driven by the script's procedure steps. */
    entries: Parameters<typeof emitContract>[0]["entries"];
    /** `Read` output members and body. */
    output: string;
    readBody: string;
    /** INITIALIZE body. */
    initialize: string;
    /** Script steps. */
    steps: CallStep[];
    prelude?: string;
    extraStructs?: string;
    initializeLocals?: string;
}

function patternArchetype(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, spec: (axis: AxisAssignment) => PatternSpec): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["capacity", "placement"],
        build(axis) {
            const shape = spec(axis);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: "container pattern",
                },
                prelude: shape.prelude,
                extraStructs: shape.extraStructs,
                state: shape.state,
                entries: [...shape.entries, { name: "Read", kind: "function", number: 1, output: shape.output, body: shape.readBody }],
                initializeLocals: shape.initializeLocals,
                initialize: shape.initialize,
            });
            return { source, script: script(shape.steps) };
        },
    };
}

export const CONTAINER_PATTERN_ARCHETYPES: Archetype[] = [
    patternArchetype(
        {
            name: "RingBufferWrapAround",
            family: "containers",
            solidity: `${OZ}/DoubleEndedQueue.sol`,
            stresses:
                "a ring buffer driven past its capacity so head and tail both wrap, with the count kept separately — the classic place an index is masked one element too late",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `Array<uint64, ${capacity}> slots;\nuint64 head;\nuint64 tail;\nuint64 count;\nuint64 dropped;\nuint64 popped;`,
                entries: [
                    {
                        name: "Push",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 index;",
                        body: `
                            if (state.get().count == ${capacity})
                            {
                                state.mut().dropped++;
                            }
                            else
                            {
                                locals.index = QPI::mod(state.get().tail, (uint64)${capacity});
                                state.mut().slots.set(locals.index, input.value);
                                state.mut().tail++;
                                state.mut().count++;
                            }
                        `,
                    },
                    {
                        name: "Pop",
                        kind: "procedure",
                        number: 2,
                        output: "uint64 value;",
                        locals: "uint64 index;",
                        body: `
                            if (state.get().count == 0)
                            {
                                output.value = 0;
                            }
                            else
                            {
                                locals.index = QPI::mod(state.get().head, (uint64)${capacity});
                                output.value = state.get().slots.get(locals.index);
                                state.mut().head++;
                                state.mut().count--;
                                state.mut().popped++;
                            }
                        `,
                    },
                ],
                output: "uint64 head;\nuint64 tail;\nuint64 count;\nuint64 dropped;\nuint64 popped;\nuint64 first;",
                readBody: `
                    output.head = state.get().head;
                    output.tail = state.get().tail;
                    output.count = state.get().count;
                    output.dropped = state.get().dropped;
                    output.popped = state.get().popped;
                    output.first = state.get().slots.get(QPI::mod(state.get().head, (uint64)${capacity}));
                `,
                initialize:
                    "state.mut().slots.setAll(0);\nstate.mut().head = 0;\nstate.mut().tail = 0;\nstate.mut().count = 0;\nstate.mut().dropped = 0;\nstate.mut().popped = 0;",
                steps: [
                    ...Array.from({ length: capacity + 2 }, (_, index): CallStep => ({
                        kind: "procedure",
                        entry: 1,
                        in: u64(index + 1),
                        invocator: 0,
                        note: `push ${index + 1}`,
                    })),
                    { kind: "function", entry: 1, note: "full, with two drops" },
                    ...Array.from({ length: 3 }, (): CallStep => ({ kind: "procedure", entry: 2, invocator: 0, note: "pop" })),
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(99), invocator: 0, note: "push into the wrapped region" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "SwapAndPopRemoval",
            family: "containers",
            solidity: `${OZ}/EnumerableSet.sol`,
            stresses:
                "removal by swapping the last element into the hole and shrinking — the index map has to be updated for the *moved* element, which is the step everyone forgets",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            const writes = Math.min(fillCount(axis, capacity), capacity);
            return {
                state: `Array<uint64, ${capacity}> values;\nHashMap<uint64, uint64, ${capacity}> indexOf;\nuint64 length;\nuint64 removals;\nuint64 staleIndexes;`,
                entries: [
                    {
                        name: "Add",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 existing;",
                        body: `
                            locals.existing = 0;
                            if (state.get().indexOf.get(input.value, locals.existing))
                            {
                                return;
                            }
                            if (state.get().length >= ${capacity})
                            {
                                return;
                            }
                            state.mut().values.set(state.get().length, input.value);
                            state.mut().indexOf.set(input.value, state.get().length);
                            state.mut().length++;
                        `,
                    },
                    {
                        name: "Remove",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 value;",
                        locals: "uint64 index;\nuint64 lastValue;\nsint64 slot;",
                        body: `
                            locals.index = 0;
                            if (!state.get().indexOf.get(input.value, locals.index))
                            {
                                return;
                            }
                            locals.lastValue = state.get().values.get(state.get().length - 1);
                            state.mut().values.set(locals.index, locals.lastValue);
                            // The moved element's index must follow it, or the map points at the hole.
                            state.mut().indexOf.set(locals.lastValue, locals.index);
                            locals.slot = state.mut().indexOf.removeByKey(input.value);
                            state.mut().length--;
                            state.mut().removals++;
                        `,
                    },
                    {
                        name: "Audit",
                        kind: "procedure",
                        number: 3,
                        locals: "uint64 i;\nuint64 recorded;",
                        body: `
                            state.mut().staleIndexes = 0;
                            for (locals.i = 0; locals.i < state.get().length; locals.i++)
                            {
                                locals.recorded = 18446744073709551615ULL;
                                state.get().indexOf.get(state.get().values.get(locals.i), locals.recorded);
                                if (locals.recorded != locals.i)
                                {
                                    state.mut().staleIndexes++;
                                }
                            }
                        `,
                    },
                ],
                output: "uint64 length;\nuint64 removals;\nuint64 staleIndexes;\nuint64 population;\nuint64 firstValue;",
                readBody: `
                    output.length = state.get().length;
                    output.removals = state.get().removals;
                    output.staleIndexes = state.get().staleIndexes;
                    output.population = state.get().indexOf.population();
                    output.firstValue = state.get().values.get(0);
                `,
                initialize:
                    "state.mut().values.setAll(0);\nstate.mut().indexOf.reset();\nstate.mut().length = 0;\nstate.mut().removals = 0;\nstate.mut().staleIndexes = 0;",
                steps: [
                    ...Array.from({ length: writes }, (_, index): CallStep => ({
                        kind: "procedure",
                        entry: 1,
                        in: u64((index + 1) * 10),
                        invocator: 0,
                        note: `add ${(index + 1) * 10}`,
                    })),
                    { kind: "procedure", entry: 3, invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(10), invocator: 0, note: "remove the first, moving the last into its place" },
                    { kind: "procedure", entry: 3, invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(999), invocator: 0, note: "remove something absent" },
                    { kind: "procedure", entry: 3, invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "CheckpointBinarySearchUpperBound",
            family: "containers",
            solidity: "openzeppelin-contracts/contracts/utils/structs/Checkpoints.sol",
            stresses:
                "an upper-bound binary search over a partially filled, sorted array — queried below the first key, between keys, exactly on a key and past the last",
            caveat: "Checkpoints stores (key, value) pairs in a dynamic array; the port uses a fixed one with an explicit length, so the search bound is the length rather than the capacity.",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `Array<uint64, ${capacity}> keys;\nArray<uint64, ${capacity}> values;\nuint64 length;\nuint64 lastAnswer;\nuint64 queries;\nuint64 misses;`,
                entries: [
                    {
                        name: "Push",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nuint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().length >= ${capacity})
                            {
                                return;
                            }
                            if (state.get().length > 0 && state.get().keys.get(state.get().length - 1) >= input.key)
                            {
                                return;
                            }
                            state.mut().keys.set(state.get().length, input.key);
                            state.mut().values.set(state.get().length, input.value);
                            state.mut().length++;
                        `,
                    },
                    {
                        name: "Lookup",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 key;",
                        output: "uint64 value;",
                        locals: "uint64 low;\nuint64 high;\nuint64 middle;",
                        body: `
                            locals.low = 0;
                            locals.high = state.get().length;
                            while (locals.low < locals.high)
                            {
                                locals.middle = locals.low + QPI::div(locals.high - locals.low, 2ULL);
                                if (state.get().keys.get(locals.middle) > input.key)
                                {
                                    locals.high = locals.middle;
                                }
                                else
                                {
                                    locals.low = locals.middle + 1;
                                }
                            }
                            state.mut().queries++;
                            if (locals.low == 0)
                            {
                                state.mut().misses++;
                                state.mut().lastAnswer = 0;
                                output.value = 0;
                            }
                            else
                            {
                                state.mut().lastAnswer = state.get().values.get(locals.low - 1);
                                output.value = state.get().lastAnswer;
                            }
                        `,
                    },
                ],
                output: "uint64 length;\nuint64 lastAnswer;\nuint64 queries;\nuint64 misses;",
                readBody: `
                    output.length = state.get().length;
                    output.lastAnswer = state.get().lastAnswer;
                    output.queries = state.get().queries;
                    output.misses = state.get().misses;
                `,
                initialize:
                    "state.mut().keys.setAll(0);\nstate.mut().values.setAll(0);\nstate.mut().length = 0;\nstate.mut().lastAnswer = 0;\nstate.mut().queries = 0;\nstate.mut().misses = 0;",
                steps: [
                    { kind: "procedure", entry: 1, in: u64(10) + u64(100), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(20) + u64(200), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(30) + u64(300), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(30) + u64(999), invocator: 0, note: "not strictly increasing — refused" },
                    { kind: "procedure", entry: 2, in: u64(5), invocator: 0, note: "below the first key" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(10), invocator: 0, note: "exactly on a key" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(25), invocator: 0, note: "between keys" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(1000), invocator: 0, note: "past the last" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "StackPushPopUnderflow",
            family: "containers",
            solidity: `${SOL}/array/pop_array_storage.sol`,
            stresses: "a stack popped past empty, where the depth counter must not wrap and the element left behind must not be read as live",
            caveat: "Solidity's `pop()` on an empty array reverts; the port returns a sentinel and counts the attempt, since QPI has no revert.",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `Array<uint64, ${capacity}> slots;\nuint64 depth;\nuint64 underflows;\nuint64 overflows;\nuint64 lastPopped;`,
                entries: [
                    {
                        name: "Push",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().depth >= ${capacity})
                            {
                                state.mut().overflows++;
                            }
                            else
                            {
                                state.mut().slots.set(state.get().depth, input.value);
                                state.mut().depth++;
                            }
                        `,
                    },
                    {
                        name: "Pop",
                        kind: "procedure",
                        number: 2,
                        output: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().depth == 0)
                            {
                                state.mut().underflows++;
                                output.value = 18446744073709551615ULL;
                            }
                            else
                            {
                                state.mut().depth--;
                                state.mut().lastPopped = state.get().slots.get(state.get().depth);
                                output.value = state.get().lastPopped;
                            }
                        `,
                    },
                ],
                output: "uint64 depth;\nuint64 underflows;\nuint64 overflows;\nuint64 lastPopped;\nuint64 topSlot;",
                readBody: `
                    output.depth = state.get().depth;
                    output.underflows = state.get().underflows;
                    output.overflows = state.get().overflows;
                    output.lastPopped = state.get().lastPopped;
                    output.topSlot = state.get().slots.get(state.get().depth);
                `,
                initialize:
                    "state.mut().slots.setAll(0);\nstate.mut().depth = 0;\nstate.mut().underflows = 0;\nstate.mut().overflows = 0;\nstate.mut().lastPopped = 0;",
                steps: [
                    { kind: "procedure", entry: 2, invocator: 0, note: "pop an empty stack" },
                    { kind: "function", entry: 1 },
                    ...Array.from({ length: capacity + 1 }, (_, index): CallStep => ({ kind: "procedure", entry: 1, in: u64(index + 1), invocator: 0 })),
                    { kind: "function", entry: 1, note: "one push too many" },
                    { kind: "procedure", entry: 2, invocator: 0 },
                    { kind: "procedure", entry: 2, invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "LruEvictionByTimestamp",
            family: "containers",
            solidity: "no Solidity analogue (cache eviction)",
            stresses:
                "a fixed-size cache that evicts its least recently used entry, with recency taken from the tick counter — a linear scan for a minimum, where ties have to break the same way on both backends",
            caveat: "No Solidity contract caches like this; the shape comes from off-chain code and is included because a minimum-scan with ties is exactly where two code generators can disagree without either being wrong.",
        },
        (axis) => {
            const capacity = Math.min(8, capacityOf(axis, 8));
            return {
                state: `Array<uint64, ${capacity}> keys;\nArray<uint64, ${capacity}> stamps;\nuint64 filled;\nuint64 evictions;\nuint64 hits;\nuint64 lastEvictedKey;`,
                entries: [
                    {
                        name: "Touch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;",
                        locals: "uint64 i;\nuint64 oldest;\nuint64 oldestIndex;\nuint64 found;",
                        body: `
                            locals.found = 0;
                            for (locals.i = 0; locals.i < state.get().filled; locals.i++)
                            {
                                if (state.get().keys.get(locals.i) == input.key)
                                {
                                    state.mut().stamps.set(locals.i, (uint64)qpi.tick());
                                    state.mut().hits++;
                                    locals.found = 1;
                                }
                            }
                            if (locals.found != 0)
                            {
                                return;
                            }
                            if (state.get().filled < ${capacity})
                            {
                                state.mut().keys.set(state.get().filled, input.key);
                                state.mut().stamps.set(state.get().filled, (uint64)qpi.tick());
                                state.mut().filled++;
                                return;
                            }
                            locals.oldest = 18446744073709551615ULL;
                            locals.oldestIndex = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                if (state.get().stamps.get(locals.i) < locals.oldest)
                                {
                                    locals.oldest = state.get().stamps.get(locals.i);
                                    locals.oldestIndex = locals.i;
                                }
                            }
                            state.mut().lastEvictedKey = state.get().keys.get(locals.oldestIndex);
                            state.mut().keys.set(locals.oldestIndex, input.key);
                            state.mut().stamps.set(locals.oldestIndex, (uint64)qpi.tick());
                            state.mut().evictions++;
                        `,
                    },
                ],
                output: "uint64 filled;\nuint64 evictions;\nuint64 hits;\nuint64 lastEvictedKey;\nuint64 firstKey;",
                readBody: `
                    output.filled = state.get().filled;
                    output.evictions = state.get().evictions;
                    output.hits = state.get().hits;
                    output.lastEvictedKey = state.get().lastEvictedKey;
                    output.firstKey = state.get().keys.get(0);
                `,
                initialize:
                    "state.mut().keys.setAll(0);\nstate.mut().stamps.setAll(0);\nstate.mut().filled = 0;\nstate.mut().evictions = 0;\nstate.mut().hits = 0;\nstate.mut().lastEvictedKey = 0;",
                steps: [
                    ...Array.from({ length: capacity }, (_, index): CallStep => ({
                        kind: "procedure",
                        entry: 1,
                        in: u64(index + 1),
                        invocator: 0,
                        note: `key ${index + 1}`,
                    })),
                    { kind: "function", entry: 1, note: "full, every stamp equal" },
                    { kind: "advanceTick", n: 1 },
                    { kind: "procedure", entry: 1, in: u64(1), invocator: 0, note: "refresh the first key" },
                    { kind: "advanceTick", n: 1 },
                    { kind: "procedure", entry: 1, in: u64(99), invocator: 0, note: "evict the oldest" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "TwoQueuesShareOneArray",
            family: "containers",
            solidity: `${OZ}/DoubleEndedQueue.sol`,
            stresses:
                "two independent queues growing toward each other in one array — the collision check is an arithmetic comparison between two indices, and getting it one out either loses an element or overwrites one",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `Array<uint64, ${capacity}> slots;\nuint64 lowNext;\nuint64 highNext;\nuint64 collisions;\nuint64 lowCount;\nuint64 highCount;`,
                entries: [
                    {
                        name: "PushLow",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().lowNext > state.get().highNext)
                            {
                                state.mut().collisions++;
                            }
                            else
                            {
                                state.mut().slots.set(state.get().lowNext, input.value);
                                state.mut().lowNext++;
                                state.mut().lowCount++;
                            }
                        `,
                    },
                    {
                        name: "PushHigh",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().highNext < state.get().lowNext)
                            {
                                state.mut().collisions++;
                            }
                            else
                            {
                                state.mut().slots.set(state.get().highNext, input.value);
                                state.mut().highNext--;
                                state.mut().highCount++;
                            }
                        `,
                    },
                ],
                output: "uint64 lowNext;\nuint64 highNext;\nuint64 collisions;\nuint64 lowCount;\nuint64 highCount;\nuint64 middleSlot;",
                readBody: `
                    output.lowNext = state.get().lowNext;
                    output.highNext = state.get().highNext;
                    output.collisions = state.get().collisions;
                    output.lowCount = state.get().lowCount;
                    output.highCount = state.get().highCount;
                    output.middleSlot = state.get().slots.get(${capacity >> 1});
                `,
                initialize: `state.mut().slots.setAll(0);\nstate.mut().lowNext = 0;\nstate.mut().highNext = ${capacity - 1};\nstate.mut().collisions = 0;\nstate.mut().lowCount = 0;\nstate.mut().highCount = 0;`,
                steps: [
                    ...Array.from({ length: capacity }, (_, index): CallStep => ({
                        kind: "procedure",
                        entry: index % 2 === 0 ? 1 : 2,
                        in: u64(index + 1),
                        invocator: 0,
                        note: index % 2 === 0 ? "low" : "high",
                    })),
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(77), invocator: 0, note: "one past the meeting point" },
                    { kind: "procedure", entry: 2, in: u64(88), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "PrefixSumsAndRangeQueries",
            family: "containers",
            solidity: "no Solidity analogue (prefix sums)",
            stresses:
                "a prefix-sum array maintained on every write, with range queries answered by subtraction — a wrong prefix shows up only when the range is queried, several calls later",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `Array<uint64, ${capacity}> values;\nArray<uint64, ${capacity}> prefix;\nuint64 lastRangeSum;\nuint64 queries;\nuint64 mismatches;`,
                entries: [
                    {
                        name: "Set",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;\nuint64 value;",
                        locals: "uint64 i;\nuint64 running;",
                        body: `
                            state.mut().values.set(input.index, input.value);
                            locals.running = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.running += state.get().values.get(locals.i);
                                state.mut().prefix.set(locals.i, locals.running);
                            }
                        `,
                    },
                    {
                        name: "Range",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 from;\nuint64 to;",
                        output: "uint64 sum;",
                        locals: "uint64 i;\nuint64 direct;\nuint64 viaPrefix;",
                        body: `
                            locals.direct = 0;
                            for (locals.i = input.from; locals.i < input.to && locals.i < ${capacity}; locals.i++)
                            {
                                locals.direct += state.get().values.get(locals.i);
                            }
                            if (input.to == 0 || input.from >= ${capacity})
                            {
                                locals.viaPrefix = 0;
                            }
                            else if (input.from == 0)
                            {
                                locals.viaPrefix = state.get().prefix.get(input.to - 1);
                            }
                            else
                            {
                                locals.viaPrefix = state.get().prefix.get(input.to - 1) - state.get().prefix.get(input.from - 1);
                            }
                            state.mut().queries++;
                            state.mut().lastRangeSum = locals.viaPrefix;
                            if (locals.direct != locals.viaPrefix)
                            {
                                state.mut().mismatches++;
                            }
                            output.sum = locals.viaPrefix;
                        `,
                    },
                ],
                output: "uint64 lastRangeSum;\nuint64 queries;\nuint64 mismatches;\nuint64 total;",
                readBody: `
                    output.lastRangeSum = state.get().lastRangeSum;
                    output.queries = state.get().queries;
                    output.mismatches = state.get().mismatches;
                    output.total = state.get().prefix.get(${capacity - 1});
                `,
                initialize:
                    "state.mut().values.setAll(0);\nstate.mut().prefix.setAll(0);\nstate.mut().lastRangeSum = 0;\nstate.mut().queries = 0;\nstate.mut().mismatches = 0;",
                steps: [
                    { kind: "procedure", entry: 1, in: u64(0) + u64(5), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(1) + u64(7), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(BigInt(capacity - 1)) + u64(11), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(0) + u64(2), invocator: 0, note: "prefix from the start" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(1) + u64(BigInt(capacity)), invocator: 0, note: "to the end" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(3) + u64(3), invocator: 0, note: "an empty range" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "PriorityInsertionSorted",
            family: "containers",
            solidity: "no Solidity analogue (sorted insert)",
            stresses:
                "insertion into a sorted array by shifting the tail — the shift runs backwards, and running it forwards instead smears one element over the rest",
        },
        (axis) => {
            const capacity = Math.min(16, capacityOf(axis, 8));
            return {
                state: `Array<uint64, ${capacity}> values;\nuint64 length;\nuint64 shifts;\nuint64 rejected;\nuint64 outOfOrder;`,
                entries: [
                    {
                        name: "Insert",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 i;\nuint64 position;",
                        body: `
                            if (state.get().length >= ${capacity})
                            {
                                state.mut().rejected++;
                                return;
                            }
                            locals.position = state.get().length;
                            for (locals.i = 0; locals.i < state.get().length; locals.i++)
                            {
                                if (state.get().values.get(locals.i) > input.value && locals.position == state.get().length)
                                {
                                    locals.position = locals.i;
                                }
                            }
                            for (locals.i = state.get().length; locals.i > locals.position; locals.i--)
                            {
                                state.mut().values.set(locals.i, state.get().values.get(locals.i - 1));
                                state.mut().shifts++;
                            }
                            state.mut().values.set(locals.position, input.value);
                            state.mut().length++;
                            state.mut().outOfOrder = 0;
                            for (locals.i = 1; locals.i < state.get().length; locals.i++)
                            {
                                if (state.get().values.get(locals.i) < state.get().values.get(locals.i - 1))
                                {
                                    state.mut().outOfOrder++;
                                }
                            }
                        `,
                    },
                ],
                output: "uint64 length;\nuint64 shifts;\nuint64 rejected;\nuint64 outOfOrder;\nuint64 first;\nuint64 last;",
                readBody: `
                    output.length = state.get().length;
                    output.shifts = state.get().shifts;
                    output.rejected = state.get().rejected;
                    output.outOfOrder = state.get().outOfOrder;
                    output.first = state.get().values.get(0);
                    output.last = state.get().values.get(state.get().length == 0 ? 0 : state.get().length - 1);
                `,
                initialize:
                    "state.mut().values.setAll(0);\nstate.mut().length = 0;\nstate.mut().shifts = 0;\nstate.mut().rejected = 0;\nstate.mut().outOfOrder = 0;",
                steps: [
                    ...[50n, 20n, 70n, 20n, 10n, 90n].map((value): CallStep => ({
                        kind: "procedure",
                        entry: 1,
                        in: u64(value),
                        invocator: 0,
                        note: `insert ${value}`,
                    })),
                    { kind: "function", entry: 1 },
                    ...Array.from({ length: capacity }, (_, index): CallStep => ({ kind: "procedure", entry: 1, in: u64(index * 3 + 1), invocator: 0 })),
                    { kind: "function", entry: 1, note: "past capacity" },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "BitmapAllocatorFirstFree",
            family: "containers",
            solidity: "openzeppelin-contracts/contracts/utils/structs/BitMaps.sol",
            stresses:
                "an allocator that finds the first clear bit, sets it, and frees by index — the scan, the set and the free all address the same bit differently",
        },
        (axis) => {
            const capacity = Math.max(64, capacityOf(axis, 64));
            return {
                state: `BitArray<${capacity}> used;\nuint64 allocations;\nuint64 frees;\nuint64 exhausted;\nuint64 lastIndex;`,
                entries: [
                    {
                        name: "Allocate",
                        kind: "procedure",
                        number: 1,
                        output: "uint64 index;",
                        locals: "uint64 i;\nuint64 found;",
                        body: `
                            locals.found = ${capacity};
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                if (locals.found == ${capacity} && state.get().used.get(locals.i) == 0)
                                {
                                    locals.found = locals.i;
                                }
                            }
                            if (locals.found == ${capacity})
                            {
                                state.mut().exhausted++;
                                output.index = 18446744073709551615ULL;
                            }
                            else
                            {
                                state.mut().used.set(locals.found, 1);
                                state.mut().allocations++;
                                state.mut().lastIndex = locals.found;
                                output.index = locals.found;
                            }
                        `,
                    },
                    {
                        name: "Free",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 index;",
                        locals: "uint64 masked;",
                        body: `
                            locals.masked = input.index & ${capacity - 1}ULL;
                            if (state.get().used.get(locals.masked) != 0)
                            {
                                state.mut().used.set(locals.masked, 0);
                                state.mut().frees++;
                            }
                        `,
                    },
                ],
                output: "uint64 allocations;\nuint64 frees;\nuint64 exhausted;\nuint64 lastIndex;\nuint64 bitZero;\nuint64 bitLast;",
                readBody: `
                    output.allocations = state.get().allocations;
                    output.frees = state.get().frees;
                    output.exhausted = state.get().exhausted;
                    output.lastIndex = state.get().lastIndex;
                    output.bitZero = state.get().used.get(0);
                    output.bitLast = state.get().used.get(${capacity - 1});
                `,
                initialize:
                    "state.mut().used.setAll(0);\nstate.mut().allocations = 0;\nstate.mut().frees = 0;\nstate.mut().exhausted = 0;\nstate.mut().lastIndex = 0;",
                steps: [
                    ...Array.from({ length: 4 }, (): CallStep => ({ kind: "procedure", entry: 1, invocator: 0, note: "allocate" })),
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(1), invocator: 0, note: "free the middle one" },
                    { kind: "procedure", entry: 1, invocator: 0, note: "must reuse index 1" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(BigInt(capacity)), invocator: 0, note: "an index past the end, masked" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "PairedTablesKeptConsistent",
            family: "containers",
            solidity: `${SOL}/mappings/mapping_of_mappings.sol`,
            stresses:
                "a forward and a reverse table updated together, with an audit pass that walks one and checks the other — the shape where a removal from one side leaves the other pointing at nothing",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `HashMap<uint64, uint64, ${capacity}> forward;\nHashMap<uint64, uint64, ${capacity}> reverse;\nuint64 bound;\nuint64 unbound;\nuint64 orphans;`,
                entries: [
                    {
                        name: "Bind",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 left;\nuint64 right;",
                        locals: "sint64 slot;",
                        body: `
                            locals.slot = state.mut().forward.set(input.left, input.right);
                            locals.slot = state.mut().reverse.set(input.right, input.left);
                            state.mut().bound++;
                        `,
                    },
                    {
                        name: "UnbindForwardOnly",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 left;",
                        locals: "sint64 slot;",
                        body: `
                            locals.slot = state.mut().forward.removeByKey(input.left);
                            if (locals.slot >= 0)
                            {
                                state.mut().unbound++;
                            }
                        `,
                    },
                    {
                        name: "Audit",
                        kind: "procedure",
                        number: 3,
                        input: "uint64 count;",
                        locals: "uint64 i;\nuint64 right;\nuint64 left;",
                        body: `
                            state.mut().orphans = 0;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.right = 0;
                                if (state.get().forward.get(locals.i, locals.right))
                                {
                                    locals.left = 18446744073709551615ULL;
                                    if (!state.get().reverse.get(locals.right, locals.left) || locals.left != locals.i)
                                    {
                                        state.mut().orphans++;
                                    }
                                }
                            }
                        `,
                    },
                ],
                output: "uint64 bound;\nuint64 unbound;\nuint64 orphans;\nuint64 forwardPopulation;\nuint64 reversePopulation;",
                readBody: `
                    output.bound = state.get().bound;
                    output.unbound = state.get().unbound;
                    output.orphans = state.get().orphans;
                    output.forwardPopulation = state.get().forward.population();
                    output.reversePopulation = state.get().reverse.population();
                `,
                initialize:
                    "state.mut().forward.reset();\nstate.mut().reverse.reset();\nstate.mut().bound = 0;\nstate.mut().unbound = 0;\nstate.mut().orphans = 0;",
                steps: [
                    { kind: "procedure", entry: 1, in: u64(0) + u64(100), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(1) + u64(101), invocator: 0 },
                    { kind: "procedure", entry: 3, in: u64(4), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(0), invocator: 0, note: "one side only" },
                    { kind: "procedure", entry: 3, in: u64(4), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(1) + u64(202), invocator: 0, note: "rebind the right-hand side" },
                    { kind: "procedure", entry: 3, in: u64(4), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "BatchInsertThenCompactScan",
            family: "containers",
            solidity: `${SOL}/array/copy_removes_bytes_data.sol`,
            stresses:
                "a compaction pass that moves live elements down over the holes — two indices walking at different speeds, which is the loop most likely to be got wrong by one",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `Array<uint64, ${capacity}> values;\nuint64 length;\nuint64 holes;\nuint64 compactions;\nuint64 moved;`,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nuint64 bounded;",
                        body: `
                            locals.bounded = input.count > ${capacity} ? ${capacity} : input.count;
                            for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                            {
                                state.mut().values.set(locals.i, locals.i + 1);
                            }
                            state.mut().length = locals.bounded;
                        `,
                    },
                    {
                        name: "Punch",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 stride;",
                        locals: "uint64 i;",
                        body: `
                            if (input.stride == 0)
                            {
                                return;
                            }
                            for (locals.i = 0; locals.i < state.get().length; locals.i += input.stride)
                            {
                                if (state.get().values.get(locals.i) != 0)
                                {
                                    state.mut().values.set(locals.i, 0);
                                    state.mut().holes++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Compact",
                        kind: "procedure",
                        number: 3,
                        locals: "uint64 read;\nuint64 write;",
                        body: `
                            locals.write = 0;
                            for (locals.read = 0; locals.read < state.get().length; locals.read++)
                            {
                                if (state.get().values.get(locals.read) != 0)
                                {
                                    if (locals.write != locals.read)
                                    {
                                        state.mut().values.set(locals.write, state.get().values.get(locals.read));
                                        state.mut().values.set(locals.read, 0);
                                        state.mut().moved++;
                                    }
                                    locals.write++;
                                }
                            }
                            state.mut().length = locals.write;
                            state.mut().compactions++;
                        `,
                    },
                ],
                output: "uint64 length;\nuint64 holes;\nuint64 compactions;\nuint64 moved;\nuint64 first;\nuint64 second;",
                readBody: `
                    output.length = state.get().length;
                    output.holes = state.get().holes;
                    output.compactions = state.get().compactions;
                    output.moved = state.get().moved;
                    output.first = state.get().values.get(0);
                    output.second = state.get().values.get(1);
                `,
                initialize:
                    "state.mut().values.setAll(0);\nstate.mut().length = 0;\nstate.mut().holes = 0;\nstate.mut().compactions = 0;\nstate.mut().moved = 0;",
                steps: [
                    { kind: "procedure", entry: 1, in: u64(BigInt(capacity)), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(2), invocator: 0, note: "punch every second element" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 3, invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 3, invocator: 0, note: "compacting an already compact array" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),

    patternArchetype(
        {
            name: "AccountBookWithIterationOrder",
            family: "containers",
            solidity: `${SOL}/mappings/mapping_iteration.sol`,
            stresses:
                "a HashMap paired with an insertion-ordered key list, so the contract can iterate deterministically — the list and the table have to stay in step through inserts, updates and one removal",
            caveat: "Solidity mappings cannot be iterated at all, which is why every contract that needs it carries this pair; the port keeps the pair and the audit that checks it.",
        },
        (axis) => {
            const capacity = capacityOf(axis, 8);
            return {
                state: `HashMap<uint64, uint64, ${capacity}> balances;\nArray<uint64, ${capacity}> order;\nuint64 length;\nuint64 sumByIteration;\nuint64 sumByInsertion;\nuint64 mismatches;`,
                entries: [
                    {
                        name: "Credit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 account;\nuint64 amount;",
                        locals: "uint64 current;\nuint64 i;\nuint64 known;",
                        body: `
                            locals.current = 0;
                            locals.known = state.get().balances.get(input.account, locals.current) ? 1 : 0;
                            state.mut().balances.set(input.account, locals.current + input.amount);
                            state.mut().sumByInsertion += input.amount;
                            if (locals.known == 0 && state.get().length < ${capacity})
                            {
                                state.mut().order.set(state.get().length, input.account);
                                state.mut().length++;
                            }
                        `,
                    },
                    {
                        name: "Total",
                        kind: "procedure",
                        number: 2,
                        locals: "uint64 i;\nuint64 value;\nuint64 running;",
                        body: `
                            locals.running = 0;
                            for (locals.i = 0; locals.i < state.get().length; locals.i++)
                            {
                                locals.value = 0;
                                state.get().balances.get(state.get().order.get(locals.i), locals.value);
                                locals.running += locals.value;
                            }
                            state.mut().sumByIteration = locals.running;
                            if (locals.running != state.get().sumByInsertion)
                            {
                                state.mut().mismatches++;
                            }
                        `,
                    },
                ],
                output: "uint64 length;\nuint64 sumByIteration;\nuint64 sumByInsertion;\nuint64 mismatches;\nuint64 population;",
                readBody: `
                    output.length = state.get().length;
                    output.sumByIteration = state.get().sumByIteration;
                    output.sumByInsertion = state.get().sumByInsertion;
                    output.mismatches = state.get().mismatches;
                    output.population = state.get().balances.population();
                `,
                initialize:
                    "state.mut().balances.reset();\nstate.mut().order.setAll(0);\nstate.mut().length = 0;\nstate.mut().sumByIteration = 0;\nstate.mut().sumByInsertion = 0;\nstate.mut().mismatches = 0;",
                steps: [
                    { kind: "procedure", entry: 1, in: u64(7) + u64(100), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(9) + u64(50), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(7) + u64(25), invocator: 0, note: "an update, not an insert" },
                    { kind: "procedure", entry: 2, invocator: 0 },
                    { kind: "function", entry: 1 },
                    ...Array.from({ length: capacity }, (_, index): CallStep => ({ kind: "procedure", entry: 1, in: u64(100 + index) + u64(1), invocator: 0 })),
                    { kind: "procedure", entry: 2, invocator: 0, note: "past capacity on both sides" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ],
            };
        },
    ),
];
