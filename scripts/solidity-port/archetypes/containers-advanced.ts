// The containers the earlier rounds did not reach: Collection, nesting, and key collisions.
//
// `Collection` is QPI's priority queue keyed by point of view — a doubly-linked structure with its own
// index space, no Solidity analogue whatsoever, and by far the most internal state any QPI container
// carries. The rest of this file is about *nesting and collision*: a HashMap inside an Array, two
// containers inside one struct inside state, keys engineered to land in the same bucket. In every case
// the interesting bytes are the container's own bookkeeping, which no statement in the contract writes
// directly and which the final-state digest covers in full.

import { emitContract } from "../emit";
import { capacityOf, fillCount } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";
const OZ = "openzeppelin-contracts/contracts/utils/structs";

function drive(values: bigint[], entry = 1): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry, in: u64(value), invocator: 0, note: `n=${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const CONTAINER_ADVANCED_ARCHETYPES: Archetype[] = [
    {
        name: "CollectionPriorityQueueByPov",
        family: "containers",
        solidity: `${OZ}/DoubleEndedQueue.sol`,
        stresses:
            "Collection: elements added under two points of view with interleaved priorities, then walked head-to-tail — the ordering is the container's own, and every link it maintains is in the digest",
        caveat: "Solidity's DoubleEndedQueue has no priorities and no point-of-view partitioning; the walk order is the only part of the shape that carries over.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = Math.min(64, capacityOf(axis, 8));
            const source = emitContract({
                axis,
                name: "CollectionPriorityQueueByPov",
                header: {
                    archetype: "CollectionPriorityQueueByPov",
                    family: "containers",
                    solidity: `${OZ}/DoubleEndedQueue.sol`,
                    stresses: "priority ordering and the head-to-tail walk under two povs",
                    caveat: "no priorities or povs in the Solidity original",
                    axis: `capacity=${capacity}`,
                },
                state: `Collection<uint64, ${capacity}> queue;\nuint64 added;\nuint64 walked;\nuint64 headValue;\nuint64 tailValue;\nuint64 outOfOrder;`,
                entries: [
                    {
                        name: "Add",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;\nsint64 priority;\nuint64 povSelector;",
                        locals: "id pov;\nsint64 index;",
                        body: `
                            locals.pov = input.povSelector == 0 ? SELF : qpi.invocator();
                            locals.index = state.mut().queue.add(locals.pov, input.value, input.priority);
                            if (locals.index >= 0)
                            {
                                state.mut().added++;
                            }
                        `,
                    },
                    {
                        name: "Walk",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 povSelector;",
                        locals: "id pov;\nsint64 index;\nuint64 previous;\nuint64 guard;\nuint64 seen;",
                        body: `
                            locals.pov = input.povSelector == 0 ? SELF : qpi.invocator();
                            locals.index = state.get().queue.headIndex(locals.pov);
                            locals.previous = 0;
                            locals.guard = 0;
                            locals.seen = 0;
                            while (locals.index >= 0 && locals.guard < ${capacity * 2})
                            {
                                if (locals.seen == 0)
                                {
                                    state.mut().headValue = state.get().queue.element(locals.index);
                                }
                                else if (state.get().queue.element(locals.index) < locals.previous)
                                {
                                    state.mut().outOfOrder++;
                                }
                                locals.previous = state.get().queue.element(locals.index);
                                state.mut().tailValue = locals.previous;
                                locals.index = state.get().queue.nextElementIndex(locals.index);
                                locals.seen++;
                                locals.guard++;
                            }
                            state.mut().walked += locals.seen;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 added;\nuint64 walked;\nuint64 headValue;\nuint64 tailValue;\nuint64 outOfOrder;",
                        body: `
                            output.population = state.get().queue.population();
                            output.added = state.get().added;
                            output.walked = state.get().walked;
                            output.headValue = state.get().headValue;
                            output.tailValue = state.get().tailValue;
                            output.outOfOrder = state.get().outOfOrder;
                        `,
                    },
                ],
                initialize:
                    "state.mut().queue.reset();\nstate.mut().added = 0;\nstate.mut().walked = 0;\nstate.mut().headValue = 0;\nstate.mut().tailValue = 0;\nstate.mut().outOfOrder = 0;",
            });
            const steps: CallStep[] = [];
            for (const [value, priority, pov] of [
                [10n, 5n, 0n],
                [20n, 1n, 0n],
                [30n, 9n, 0n],
                [40n, 5n, 1n],
                [50n, 0n, 1n],
            ] as [bigint, bigint, bigint][]) {
                steps.push({
                    kind: "procedure",
                    entry: 1,
                    in: u64(value) + u64(priority) + u64(pov),
                    invocator: 0,
                    note: `value ${value} priority ${priority} pov ${pov}`,
                });
            }
            steps.push({ kind: "procedure", entry: 2, in: u64(0), invocator: 0, note: "walk the SELF queue" });
            steps.push({ kind: "function", entry: 1 });
            steps.push({ kind: "procedure", entry: 2, in: u64(1), invocator: 0, note: "walk the caller's queue" });
            steps.push({ kind: "function", entry: 1 });
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "HashMapEngineeredKeyCollisions",
        family: "containers",
        solidity: `${SOL}/mappings/mapping_of_mappings.sol`,
        stresses:
            "keys chosen to share the low bits the table indexes on, so every insert probes past an occupied slot — the open-addressing path a random key set almost never reaches",
        caveat: "Solidity's mapping is a hash into a 256-bit slot space with no collisions to speak of; the fixed-capacity table has them by construction.",
        axes: ["capacity", "fill"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const writes = Math.min(fillCount(axis, capacity), capacity);
            const source = emitContract({
                axis,
                name: "HashMapEngineeredKeyCollisions",
                header: {
                    archetype: "HashMapEngineeredKeyCollisions",
                    family: "containers",
                    solidity: `${SOL}/mappings/mapping_of_mappings.sol`,
                    stresses: "colliding keys and the probe sequence they force",
                    caveat: "Solidity mappings do not collide in practice",
                    axis: `capacity=${capacity} writes=${writes}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> table;\nuint64 inserted;\nuint64 rejected;\nuint64 found;\nuint64 missing;`,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;\nuint64 stride;",
                        locals: "uint64 i;\nuint64 key;\nsint64 slot;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                // Multiples of the capacity land on one bucket; the stride selects how hard.
                                locals.key = locals.i * input.stride;
                                locals.slot = state.mut().table.set(locals.key, locals.i + 1);
                                if (locals.slot >= 0)
                                {
                                    state.mut().inserted++;
                                }
                                else
                                {
                                    state.mut().rejected++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Probe",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 count;\nuint64 stride;",
                        locals: "uint64 i;\nuint64 value;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.value = 0;
                                if (state.get().table.get(locals.i * input.stride, locals.value))
                                {
                                    state.mut().found++;
                                }
                                else
                                {
                                    state.mut().missing++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 inserted;\nuint64 rejected;\nuint64 found;\nuint64 missing;",
                        body: `
                            output.population = state.get().table.population();
                            output.inserted = state.get().inserted;
                            output.rejected = state.get().rejected;
                            output.found = state.get().found;
                            output.missing = state.get().missing;
                        `,
                    },
                ],
                initialize:
                    "state.mut().table.reset();\nstate.mut().inserted = 0;\nstate.mut().rejected = 0;\nstate.mut().found = 0;\nstate.mut().missing = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(writes) + u64(capacity), invocator: 0, note: "every key on one bucket" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(writes) + u64(capacity), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(writes) + u64(1), invocator: 0, note: "consecutive keys on top" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(writes) + u64(1), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "ArrayOfHashMaps",
        family: "containers",
        solidity: `${SOL}/mappings/mapping_of_mappings.sol`,
        stresses:
            "a HashMap as an Array element — the outer stride is the whole table including its occupation flags, so an element size computed from the value type alone lands in the wrong table",
        caveat: "Solidity nests mappings by hashing the outer key into the slot of the inner one; here the nesting is physical.",
        axes: ["capacity", "placement"],
        build(axis) {
            const inner = Math.min(8, capacityOf(axis, 8));
            const outer = 4;
            const source = emitContract({
                axis,
                name: "ArrayOfHashMaps",
                header: {
                    archetype: "ArrayOfHashMaps",
                    family: "containers",
                    solidity: `${SOL}/mappings/mapping_of_mappings.sol`,
                    stresses: "physical nesting of a table inside an array",
                    caveat: "Solidity nests by hashing, not by layout",
                    axis: `outer=${outer} inner=${inner}`,
                },
                state: `Array<HashMap<uint64, uint64, ${inner}>, ${outer}> tables;\nuint64 canary;\nuint64 writes;`,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 outer;\nuint64 key;\nuint64 value;",
                        locals: `HashMap<uint64, uint64, ${inner}> table;`,
                        body: `
                            locals.table = state.get().tables.get(input.outer);
                            locals.table.set(input.key, input.value);
                            state.mut().tables.set(input.outer, locals.table);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 outer;\nuint64 key;",
                        output: "uint64 value;\nuint64 present;\nuint64 population;\nuint64 neighbourPopulation;\nuint64 canary;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            output.present = state.get().tables.get(input.outer).get(input.key, locals.fetched) ? 1 : 0;
                            output.value = locals.fetched;
                            output.population = state.get().tables.get(input.outer).population();
                            output.neighbourPopulation = state.get().tables.get(input.outer + 1).population();
                            output.canary = state.get().canary;
                        `,
                    },
                ],
                initializeLocals: `uint64 i;\nHashMap<uint64, uint64, ${inner}> table;`,
                initialize: `
                    state.mut().canary = 18446744073709551615ULL;
                    state.mut().writes = 0;
                    locals.table.reset();
                    for (locals.i = 0; locals.i < ${outer}; locals.i++)
                    {
                        state.mut().tables.set(locals.i, locals.table);
                    }
                `,
            });
            const steps: CallStep[] = [];
            for (const [outerIndex, key, value] of [
                [0n, 1n, 11n],
                [0n, 2n, 22n],
                [3n, 1n, 33n],
                [4n, 1n, 44n],
            ] as [bigint, bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(outerIndex) + u64(key) + u64(value), invocator: 0, note: `table ${outerIndex} key ${key}` });
                steps.push({ kind: "function", entry: 1, in: u64(outerIndex) + u64(key) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "StructHoldingTwoContainers",
        family: "containers",
        solidity: `${SOL}/structs/struct_containing_mapping.sol`,
        stresses:
            "a struct with an Array and a HashMap side by side, copied whole between locals and state — the copy has to carry the table's bookkeeping, not just its values",
        caveat: "Solidity forbids copying a struct that contains a mapping; QPI allows it, so this shape has no faithful original.",
        axes: ["capacity", "placement", "temporaries"],
        build(axis) {
            const capacity = Math.min(8, capacityOf(axis, 8));
            const source = emitContract({
                axis,
                name: "StructHoldingTwoContainers",
                header: {
                    archetype: "StructHoldingTwoContainers",
                    family: "containers",
                    solidity: `${SOL}/structs/struct_containing_mapping.sol`,
                    stresses: "whole-struct copy of a struct holding two containers",
                    caveat: "Solidity refuses this copy entirely",
                    axis: `capacity=${capacity}`,
                },
                prelude: `struct Bundle\n{\n    Array<uint64, ${capacity}> slots;\n    HashMap<uint64, uint64, ${capacity}> table;\n    uint64 stamp;\n};`,
                state: "Bundle stored;\nuint64 copies;\nuint64 sizeOfBundle;",
                entries: [
                    {
                        name: "Update",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;\nuint64 value;",
                        locals: "Bundle working;",
                        body: `
                            locals.working = state.get().stored;
                            locals.working.slots.set(input.index, input.value);
                            locals.working.table.set(input.index, input.value * 2);
                            locals.working.stamp = input.value;
                            state.mut().stored = locals.working;
                            state.mut().copies++;
                            state.mut().sizeOfBundle = sizeof(Bundle);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 index;",
                        output: "uint64 slot;\nuint64 mapped;\nuint64 present;\nuint64 population;\nuint64 stamp;\nuint64 copies;\nuint64 sizeOfBundle;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            output.present = state.get().stored.table.get(input.index, locals.fetched) ? 1 : 0;
                            output.mapped = locals.fetched;
                            output.slot = state.get().stored.slots.get(input.index);
                            output.population = state.get().stored.table.population();
                            output.stamp = state.get().stored.stamp;
                            output.copies = state.get().copies;
                            output.sizeOfBundle = state.get().sizeOfBundle;
                        `,
                    },
                ],
                initialize:
                    "state.mut().stored.slots.setAll(0);\nstate.mut().stored.table.reset();\nstate.mut().stored.stamp = 0;\nstate.mut().copies = 0;\nstate.mut().sizeOfBundle = 0;",
            });
            const steps: CallStep[] = [];
            for (const [index, value] of [
                [0n, 5n],
                [1n, 6n],
                [BigInt(capacity - 1), 7n],
                [BigInt(capacity), 8n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(index) + u64(value), invocator: 0, note: `index ${index}` });
                steps.push({ kind: "function", entry: 1, in: u64(index) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "HashSetOfHashedStructKeys",
        family: "containers",
        solidity: `${OZ}/EnumerableSet.sol`,
        stresses:
            "a set keyed on the K12 of a struct — the digest is computed from a variable rather than an expression, which is the spelling F203 showed matters",
        caveat: "EnumerableSet keys on bytes32 the caller supplies; here the key is derived inside the contract, which is what brings K12 into the picture.",
        axes: ["capacity", "fill"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const writes = Math.min(fillCount(axis, capacity), capacity);
            const source = emitContract({
                axis,
                name: "HashSetOfHashedStructKeys",
                header: {
                    archetype: "HashSetOfHashedStructKeys",
                    family: "containers",
                    solidity: `${OZ}/EnumerableSet.sol`,
                    stresses: "set membership over K12-derived keys",
                    caveat: "the key is derived in-contract, not supplied",
                    axis: `capacity=${capacity} writes=${writes}`,
                },
                extraStructs: "struct Ticket\n{\n    uint64 round;\n    uint32 seat;\n    uint8 tier;\n};",
                state: `HashSet<id, ${capacity}> issued;\nuint64 added;\nuint64 duplicates;\nuint64 lookups;\nuint64 hits;`,
                entries: [
                    {
                        name: "Issue",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;\nuint64 round;",
                        locals: "uint64 i;\nTicket ticket;\nid key;\nsint64 slot;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.ticket.round = input.round;
                                locals.ticket.seat = (uint32)locals.i;
                                locals.ticket.tier = (uint8)QPI::mod(locals.i, 3ULL);
                                locals.key = qpi.K12(locals.ticket);
                                if (state.get().issued.contains(locals.key))
                                {
                                    state.mut().duplicates++;
                                }
                                locals.slot = state.mut().issued.add(locals.key);
                                if (locals.slot >= 0)
                                {
                                    state.mut().added++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Check",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 count;\nuint64 round;",
                        locals: "uint64 i;\nTicket ticket;\nid key;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.ticket.round = input.round;
                                locals.ticket.seat = (uint32)locals.i;
                                locals.ticket.tier = (uint8)QPI::mod(locals.i, 3ULL);
                                locals.key = qpi.K12(locals.ticket);
                                state.mut().lookups++;
                                if (state.get().issued.contains(locals.key))
                                {
                                    state.mut().hits++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 added;\nuint64 duplicates;\nuint64 lookups;\nuint64 hits;",
                        body: `
                            output.population = state.get().issued.population();
                            output.added = state.get().added;
                            output.duplicates = state.get().duplicates;
                            output.lookups = state.get().lookups;
                            output.hits = state.get().hits;
                        `,
                    },
                ],
                initialize: "state.mut().issued.reset();\nstate.mut().added = 0;\nstate.mut().duplicates = 0;\nstate.mut().lookups = 0;\nstate.mut().hits = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(writes) + u64(1), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(writes) + u64(1), invocator: 0, note: "same round — every key a duplicate" },
                    { kind: "procedure", entry: 2, in: u64(writes) + u64(1), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(writes) + u64(2), invocator: 0, note: "a round that was never issued" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "BitArrayLargeSparse",
        family: "containers",
        solidity: `${SOL}/various/bit_operations.sol`,
        stresses:
            "a 2048-bit array written at word boundaries and at the last bit — 32 words of state where an index computed one word out still writes a valid-looking bit",
        caveat: "The Solidity original packs into one 256-bit word; at 2048 bits the word arithmetic is the point.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "BitArrayLargeSparse",
                header: {
                    archetype: "BitArrayLargeSparse",
                    family: "containers",
                    solidity: `${SOL}/various/bit_operations.sol`,
                    stresses: "bit indices at every word boundary of a 2048-bit array",
                    caveat: "wider than one Solidity word by design",
                    axis: "2048-bit array",
                },
                state: "BitArray<2048> flags;\nuint64 setCount;\nuint64 lastIndex;\nuint64 wordBoundaryHits;",
                entries: [
                    {
                        name: "Set",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;",
                        locals: "uint64 masked;",
                        body: `
                            locals.masked = input.index & 2047ULL;
                            state.mut().flags.set(locals.masked, 1);
                            state.mut().lastIndex = locals.masked;
                            state.mut().setCount++;
                            if ((locals.masked & 63ULL) == 0)
                            {
                                state.mut().wordBoundaryHits++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 index;",
                        output: "uint64 bit;\nuint64 neighbourBelow;\nuint64 neighbourAbove;\nuint64 setCount;\nuint64 wordBoundaryHits;",
                        body: `
                            output.bit = state.get().flags.get(input.index & 2047ULL);
                            output.neighbourBelow = state.get().flags.get((input.index - 1) & 2047ULL);
                            output.neighbourAbove = state.get().flags.get((input.index + 1) & 2047ULL);
                            output.setCount = state.get().setCount;
                            output.wordBoundaryHits = state.get().wordBoundaryHits;
                        `,
                    },
                ],
                initialize: "state.mut().flags.setAll(0);\nstate.mut().setCount = 0;\nstate.mut().lastIndex = 0;\nstate.mut().wordBoundaryHits = 0;",
            });
            const steps: CallStep[] = [];
            for (const index of [0n, 63n, 64n, 65n, 1023n, 2047n, 2048n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(index), invocator: 0, note: `bit ${index}` });
                steps.push({ kind: "function", entry: 1, in: u64(index) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "ArraySortedPredicates",
        family: "containers",
        solidity: `${SOL}/array/sorting.sol`,
        stresses: "isArraySorted and isArraySortedWithoutDuplicates over ranges, including an empty range, an inverted one and a range past the end",
        caveat: "Solidity ships no sorting predicates; contracts hand-roll the loop, which is what the archetype compares the helpers against.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = Math.min(16, capacityOf(axis, 8));
            const source = emitContract({
                axis,
                name: "ArraySortedPredicates",
                header: {
                    archetype: "ArraySortedPredicates",
                    family: "containers",
                    solidity: `${SOL}/array/sorting.sol`,
                    stresses: "the sortedness helpers against a hand-written loop",
                    caveat: "the helpers are QPI-only",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> values;\nuint64 sortedHelper;\nuint64 sortedLoop;\nuint64 strictHelper;\nuint64 disagreements;\nuint64 calls;`,
                entries: [
                    {
                        name: "Load",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 mode;",
                        locals: "uint64 i;\nuint64 sorted;",
                        body: `
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                if (input.mode == 0)
                                {
                                    state.mut().values.set(locals.i, locals.i);
                                }
                                else if (input.mode == 1)
                                {
                                    state.mut().values.set(locals.i, QPI::div(locals.i, 2ULL));
                                }
                                else
                                {
                                    state.mut().values.set(locals.i, ${capacity} - locals.i);
                                }
                            }
                            state.mut().sortedHelper = isArraySorted(state.get().values, 0, ${capacity}) ? 1 : 0;
                            state.mut().strictHelper = isArraySortedWithoutDuplicates(state.get().values, 0, ${capacity}) ? 1 : 0;
                            locals.sorted = 1;
                            for (locals.i = 1; locals.i < ${capacity}; locals.i++)
                            {
                                if (state.get().values.get(locals.i) < state.get().values.get(locals.i - 1))
                                {
                                    locals.sorted = 0;
                                }
                            }
                            state.mut().sortedLoop = locals.sorted;
                            if (locals.sorted != state.get().sortedHelper)
                            {
                                state.mut().disagreements++;
                            }
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 sortedHelper;\nuint64 sortedLoop;\nuint64 strictHelper;\nuint64 disagreements;\nuint64 emptyRange;\nuint64 invertedRange;\nuint64 pastEnd;",
                        body: `
                            output.sortedHelper = state.get().sortedHelper;
                            output.sortedLoop = state.get().sortedLoop;
                            output.strictHelper = state.get().strictHelper;
                            output.disagreements = state.get().disagreements;
                            output.emptyRange = isArraySorted(state.get().values, 2, 2) ? 1 : 0;
                            output.invertedRange = isArraySorted(state.get().values, 3, 1) ? 1 : 0;
                            output.pastEnd = isArraySorted(state.get().values, 0, ${capacity} + 4) ? 1 : 0;
                        `,
                    },
                ],
                initialize:
                    "state.mut().values.setAll(0);\nstate.mut().sortedHelper = 0;\nstate.mut().sortedLoop = 0;\nstate.mut().strictHelper = 0;\nstate.mut().disagreements = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive([0n, 1n, 2n])) };
        },
    },

    {
        name: "HashMapOverfillAtCapacityTwo",
        family: "containers",
        solidity: `${SOL}/mappings/mapping_of_mappings.sol`,
        stresses:
            "a two-slot table driven with four distinct keys — the smallest table QPI allows, where the third insert has nowhere to go and the return code is the only signal",
        caveat: "Solidity mappings never fill; the capacity is the port's own limit and this archetype exists to sit exactly on it.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HashMapOverfillAtCapacityTwo",
                header: {
                    archetype: "HashMapOverfillAtCapacityTwo",
                    family: "containers",
                    solidity: `${SOL}/mappings/mapping_of_mappings.sol`,
                    stresses: "insert, overfill, remove and re-insert on a two-slot table",
                    caveat: "capacity is the port's limit, not Solidity's",
                    axis: "capacity 2",
                },
                state: "HashMap<uint64, uint64, 2> table;\nuint64 inserted;\nuint64 refused;\nuint64 removed;\nuint64 population;",
                entries: [
                    {
                        name: "Insert",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nuint64 value;",
                        output: "sint64 slot;",
                        locals: "sint64 slot;",
                        body: `
                            locals.slot = state.mut().table.set(input.key, input.value);
                            if (locals.slot >= 0)
                            {
                                state.mut().inserted++;
                            }
                            else
                            {
                                state.mut().refused++;
                            }
                            state.mut().population = state.get().table.population();
                            output.slot = locals.slot;
                        `,
                    },
                    {
                        name: "Remove",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 key;",
                        locals: "sint64 slot;",
                        body: `
                            locals.slot = state.mut().table.removeByKey(input.key);
                            if (locals.slot >= 0)
                            {
                                state.mut().removed++;
                            }
                            state.mut().population = state.get().table.population();
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 key;",
                        output: "uint64 value;\nuint64 present;\nuint64 population;\nuint64 inserted;\nuint64 refused;\nuint64 removed;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            output.present = state.get().table.get(input.key, locals.fetched) ? 1 : 0;
                            output.value = locals.fetched;
                            output.population = state.get().table.population();
                            output.inserted = state.get().inserted;
                            output.refused = state.get().refused;
                            output.removed = state.get().removed;
                        `,
                    },
                ],
                initialize:
                    "state.mut().table.reset();\nstate.mut().inserted = 0;\nstate.mut().refused = 0;\nstate.mut().removed = 0;\nstate.mut().population = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(1) + u64(10), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(2) + u64(20), invocator: 0, note: "table is now full" },
                    { kind: "procedure", entry: 1, in: u64(3) + u64(30), invocator: 0, note: "no slot left" },
                    { kind: "function", entry: 1, in: u64(3) },
                    { kind: "procedure", entry: 1, in: u64(1) + u64(11), invocator: 0, note: "overwrite an existing key" },
                    { kind: "function", entry: 1, in: u64(1) },
                    { kind: "procedure", entry: 2, in: u64(1), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(3) + u64(30), invocator: 0, note: "the removed slot should take it" },
                    { kind: "function", entry: 1, in: u64(3) },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
