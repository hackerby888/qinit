// The QPI container APIs the earlier batches did not reach: removal, tombstones, cleanup, ranges.

import { emitContract } from "../emit";
import { capacityOf, fillCount } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";
const OZ = "openzeppelin-contracts/contracts";

export const CONTAINER_COLLECTION_ARCHETYPES: Archetype[] = [
    {
        name: "HashMapRemoveThenReAdd",
        family: "containers",
        solidity: `${SOL}/mappings/mapping_delete.sol`,
        stresses:
            "removeByKey followed by a set of the same key — the removed slot carries a marker, and re-adding has to reuse it rather than consume a fresh one",
        caveat: "Solidity's `delete m[k]` writes a zero and frees nothing; QPI's removal leaves a marker in an open-addressed table, so the two are not the same operation.",
        axes: ["capacity", "fill"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const writes = Math.min(fillCount(axis, capacity), capacity);
            const source = emitContract({
                axis,
                name: "HashMapRemoveThenReAdd",
                header: {
                    archetype: "HashMapRemoveThenReAdd",
                    family: "containers",
                    solidity: `${SOL}/mappings/mapping_delete.sol`,
                    stresses: "remove-then-re-add against the table's occupation markers",
                    caveat: "QPI removal leaves a marker; Solidity's delete does not",
                    axis: `capacity=${capacity} writes=${writes}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> table;\nuint64 removed;\nuint64 reAdded;\nuint64 populationAfterRemove;\nuint64 populationAfterReAdd;`,
                entries: [
                    {
                        name: "Cycle",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nsint64 slot;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                state.mut().table.set(locals.i, locals.i * 10 + 1);
                            }
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                if (QPI::mod(locals.i, 2ULL) == 0)
                                {
                                    locals.slot = state.mut().table.removeByKey(locals.i);
                                    if (locals.slot >= 0)
                                    {
                                        state.mut().removed++;
                                    }
                                }
                            }
                            state.mut().populationAfterRemove = state.get().table.population();
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                if (QPI::mod(locals.i, 2ULL) == 0)
                                {
                                    state.mut().table.set(locals.i, locals.i * 10 + 2);
                                    state.mut().reAdded++;
                                }
                            }
                            state.mut().populationAfterReAdd = state.get().table.population();
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 key;",
                        output: "uint64 value;\nuint64 present;\nuint64 population;\nuint64 removed;\nuint64 reAdded;\nuint64 populationAfterRemove;\nuint64 populationAfterReAdd;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            output.present = state.get().table.get(input.key, locals.fetched) ? 1 : 0;
                            output.value = locals.fetched;
                            output.population = state.get().table.population();
                            output.removed = state.get().removed;
                            output.reAdded = state.get().reAdded;
                            output.populationAfterRemove = state.get().populationAfterRemove;
                            output.populationAfterReAdd = state.get().populationAfterReAdd;
                        `,
                    },
                ],
                initialize:
                    "state.mut().table.reset();\nstate.mut().removed = 0;\nstate.mut().reAdded = 0;\nstate.mut().populationAfterRemove = 0;\nstate.mut().populationAfterReAdd = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(writes), invocator: 0, note: `${writes} keys through the cycle` },
                    { kind: "function", entry: 1, in: u64(0), note: "an even key — removed then re-added" },
                    { kind: "function", entry: 1, in: u64(1), note: "an odd key — never removed" },
                    { kind: "function", entry: 1, in: u64(capacity + 5), note: "a key that was never written" },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "HashMapCleanupCompaction",
        family: "containers",
        solidity: `${SOL}/mappings/mapping_delete.sol`,
        stresses:
            "needsCleanup and cleanup after a run of removals — compaction rewrites the table's internal layout while every surviving key must still resolve",
        caveat: "There is no Solidity analogue at all: a mapping never compacts. This is a QPI-only path, included because it rewrites state that no contract statement wrote.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "HashMapCleanupCompaction",
                header: {
                    archetype: "HashMapCleanupCompaction",
                    family: "containers",
                    solidity: "no Solidity analogue (mappings never compact)",
                    stresses: "cleanup rewriting the table under the contract's feet",
                    caveat: "QPI-only path",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> table;\nuint64 cleanupsRun;\nuint64 neededCleanup;\nuint64 survivorsFound;`,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                state.mut().table.set(locals.i, locals.i + 1000);
                            }
                        `,
                    },
                    {
                        name: "RemoveEverySecond",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 count;",
                        locals: "uint64 i;\nsint64 slot;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                if (QPI::mod(locals.i, 2ULL) == 1)
                                {
                                    locals.slot = state.mut().table.removeByKey(locals.i);
                                }
                            }
                            if (state.get().table.needsCleanup(50))
                            {
                                state.mut().neededCleanup++;
                            }
                        `,
                    },
                    {
                        name: "Cleanup",
                        kind: "procedure",
                        number: 3,
                        input: "uint64 count;",
                        locals: "uint64 i;\nuint64 fetched;",
                        body: `
                            state.mut().table.cleanup();
                            state.mut().cleanupsRun++;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.fetched = 0;
                                if (state.get().table.get(locals.i, locals.fetched))
                                {
                                    state.mut().survivorsFound++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 cleanupsRun;\nuint64 neededCleanup;\nuint64 survivorsFound;",
                        body: `
                            output.population = state.get().table.population();
                            output.cleanupsRun = state.get().cleanupsRun;
                            output.neededCleanup = state.get().neededCleanup;
                            output.survivorsFound = state.get().survivorsFound;
                        `,
                    },
                ],
                initialize: "state.mut().table.reset();\nstate.mut().cleanupsRun = 0;\nstate.mut().neededCleanup = 0;\nstate.mut().survivorsFound = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(capacity), invocator: 0, note: "fill to capacity" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(capacity), invocator: 0, note: "remove every second key" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 3, in: u64(capacity), invocator: 0, note: "compact and re-read every key" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(capacity), invocator: 0, note: "refill after compaction" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "HashSetChurnPopulation",
        family: "containers",
        solidity: `${OZ}/utils/structs/EnumerableSet.sol`,
        stresses: "add, re-add, remove and remove-again over a HashSet — the population count after each, which is the only observable the set exposes",
        caveat: "EnumerableSet keeps an index array so it can enumerate; HashSet does not, so the port compares populations rather than enumeration order.",
        axes: ["capacity", "fill"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const writes = Math.min(fillCount(axis, capacity), capacity);
            const source = emitContract({
                axis,
                name: "HashSetChurnPopulation",
                header: {
                    archetype: "HashSetChurnPopulation",
                    family: "containers",
                    solidity: `${OZ}/utils/structs/EnumerableSet.sol`,
                    stresses: "add/re-add/remove/remove-again, tracked through population()",
                    caveat: "no enumeration order to compare — HashSet has none",
                    axis: `capacity=${capacity} writes=${writes}`,
                },
                state: `HashSet<id, ${capacity}> members;\nuint64 added;\nuint64 duplicateAdds;\nuint64 removed;\nuint64 missingRemoves;`,
                entries: [
                    {
                        name: "Churn",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nid key;\nsint64 slot;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.key = qpi.K12(locals.i);
                                if (state.get().members.contains(locals.key))
                                {
                                    state.mut().duplicateAdds++;
                                }
                                locals.slot = state.mut().members.add(locals.key);
                                if (locals.slot >= 0)
                                {
                                    state.mut().added++;
                                }
                            }
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                if (QPI::mod(locals.i, 3ULL) == 0)
                                {
                                    locals.key = qpi.K12(locals.i);
                                    locals.slot = state.mut().members.remove(locals.key);
                                    if (locals.slot >= 0)
                                    {
                                        state.mut().removed++;
                                    }
                                    // The same removal again, on a key that is now gone.
                                    locals.slot = state.mut().members.remove(locals.key);
                                    if (locals.slot < 0)
                                    {
                                        state.mut().missingRemoves++;
                                    }
                                }
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 added;\nuint64 duplicateAdds;\nuint64 removed;\nuint64 missingRemoves;",
                        body: `
                            output.population = state.get().members.population();
                            output.added = state.get().added;
                            output.duplicateAdds = state.get().duplicateAdds;
                            output.removed = state.get().removed;
                            output.missingRemoves = state.get().missingRemoves;
                        `,
                    },
                ],
                initialize:
                    "state.mut().members.reset();\nstate.mut().added = 0;\nstate.mut().duplicateAdds = 0;\nstate.mut().removed = 0;\nstate.mut().missingRemoves = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(writes), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(writes), invocator: 0, note: "the same keys again — every add is a duplicate" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "ArraySetRangeAndRangeEquals",
        family: "containers",
        solidity: `${SOL}/array/fixed_arrays_as_arguments.sol`,
        stresses:
            "setRange and rangeEquals at their boundaries — an inverted range, a range past the end, and an empty range, each of which the two implementations must treat identically",
        caveat: "Solidity has no range assignment; the nearest original is a loop, so the port drives both spellings and compares them inside the contract.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "ArraySetRangeAndRangeEquals",
                header: {
                    archetype: "ArraySetRangeAndRangeEquals",
                    family: "containers",
                    solidity: `${SOL}/array/fixed_arrays_as_arguments.sol`,
                    stresses: "range assignment and range comparison at their edges",
                    caveat: "Solidity has no range assignment; the loop spelling is compared against it",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> viaRange;\nArray<uint64, ${capacity}> viaLoop;\nuint64 rangesEqual;\nuint64 arraysAgree;\nuint64 calls;`,
                entries: [
                    {
                        name: "Apply",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 begin;\nuint64 end;\nuint64 value;",
                        locals: "uint64 i;\nuint64 agree;",
                        body: `
                            state.mut().viaRange.setRange(input.begin, input.end, input.value);
                            for (locals.i = input.begin; locals.i < input.end; locals.i++)
                            {
                                state.mut().viaLoop.set(locals.i, input.value);
                            }
                            if (state.get().viaRange.rangeEquals(input.begin, input.end, input.value))
                            {
                                state.mut().rangesEqual++;
                            }
                            locals.agree = 1;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                if (state.get().viaRange.get(locals.i) != state.get().viaLoop.get(locals.i))
                                {
                                    locals.agree = 0;
                                }
                            }
                            state.mut().arraysAgree += locals.agree;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 rangesEqual;\nuint64 arraysAgree;\nuint64 calls;\nuint64 first;\nuint64 last;",
                        body: `
                            output.rangesEqual = state.get().rangesEqual;
                            output.arraysAgree = state.get().arraysAgree;
                            output.calls = state.get().calls;
                            output.first = state.get().viaRange.get(0);
                            output.last = state.get().viaRange.get(${capacity - 1});
                        `,
                    },
                ],
                initialize:
                    "state.mut().viaRange.setAll(0);\nstate.mut().viaLoop.setAll(0);\nstate.mut().rangesEqual = 0;\nstate.mut().arraysAgree = 0;\nstate.mut().calls = 0;",
            });
            const steps: CallStep[] = [];
            for (const [begin, end, value] of [
                [0n, BigInt(capacity), 7n],
                [1n, 1n, 9n],
                [2n, 1n, 11n],
                [0n, BigInt(capacity) + 4n, 13n],
                [BigInt(capacity) - 1n, BigInt(capacity), 15n],
            ] as [bigint, bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(begin) + u64(end) + u64(value), invocator: 0, note: `[${begin}, ${end}) = ${value}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "BitArraySparseClear",
        family: "containers",
        solidity: `${SOL}/various/bit_operations.sol`,
        stresses: "a BitArray set whole and then cleared sparsely — bit addressing inside a word, and the word boundary at 64",
        caveat: "Solidity has no bit array; the original packs bits into a uint256 by hand, which is what makes the addressing worth comparing.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = Math.max(64, capacityOf(axis, 64));
            const source = emitContract({
                axis,
                name: "BitArraySparseClear",
                header: {
                    archetype: "BitArraySparseClear",
                    family: "containers",
                    solidity: `${SOL}/various/bit_operations.sol`,
                    stresses: "bit addressing across the 64-bit word boundary",
                    caveat: "hand-packed uint256 bits become a BitArray",
                    axis: `capacity=${capacity}`,
                },
                state: `BitArray<${capacity}> flags;\nuint64 setCount;\nuint64 clearedCount;\nuint64 lastWordPopulation;`,
                entries: [
                    {
                        name: "Pattern",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 stride;",
                        locals: "uint64 i;\nuint64 population;",
                        body: `
                            state.mut().flags.setAll(1);
                            state.mut().setCount = ${capacity};
                            state.mut().clearedCount = 0;
                            if (input.stride == 0)
                            {
                                return;
                            }
                            for (locals.i = 0; locals.i < ${capacity}; locals.i += input.stride)
                            {
                                state.mut().flags.set(locals.i, 0);
                                state.mut().clearedCount++;
                            }
                            locals.population = 0;
                            for (locals.i = ${capacity - 64}; locals.i < ${capacity}; locals.i++)
                            {
                                locals.population += state.get().flags.get(locals.i);
                            }
                            state.mut().lastWordPopulation = locals.population;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 setCount;\nuint64 clearedCount;\nuint64 lastWordPopulation;\nuint64 bitZero;\nuint64 bit63;",
                        body: `
                            output.setCount = state.get().setCount;
                            output.clearedCount = state.get().clearedCount;
                            output.lastWordPopulation = state.get().lastWordPopulation;
                            output.bitZero = state.get().flags.get(0);
                            output.bit63 = state.get().flags.get(63);
                        `,
                    },
                ],
                initialize: "state.mut().flags.setAll(0);\nstate.mut().setCount = 0;\nstate.mut().clearedCount = 0;\nstate.mut().lastWordPopulation = 0;",
            });
            const steps: CallStep[] = [];
            for (const stride of [0n, 1n, 2n, 63n, 64n, 65n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(stride), invocator: 0, note: `stride ${stride}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "HashMapReplaceVersusSet",
        family: "containers",
        solidity: `${SOL}/mappings/mapping_assignment.sol`,
        stresses: "replace on a present key against replace on an absent one, next to set doing the same — replace must not insert, set must",
        caveat: "Solidity's `m[k] = v` always inserts; QPI's replace deliberately does not, so this pins a distinction the original does not have.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "HashMapReplaceVersusSet",
                header: {
                    archetype: "HashMapReplaceVersusSet",
                    family: "containers",
                    solidity: `${SOL}/mappings/mapping_assignment.sol`,
                    stresses: "replace (no insert) against set (insert), on present and absent keys",
                    caveat: "Solidity assignment always inserts",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> table;\nuint64 replaceHits;\nuint64 replaceMisses;\nuint64 inserts;`,
                entries: [
                    {
                        name: "Seed",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nsint64 slot;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.slot = state.mut().table.set(locals.i, locals.i + 1);
                                if (locals.slot >= 0)
                                {
                                    state.mut().inserts++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Replace",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 key;\nuint64 value;",
                        output: "uint64 ok;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.mut().table.replace(input.key, input.value))
                            {
                                state.mut().replaceHits++;
                                output.ok = 1;
                                return;
                            }
                            state.mut().replaceMisses++;
                            output.ok = 0;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 key;",
                        output: "uint64 value;\nuint64 present;\nuint64 population;\nuint64 replaceHits;\nuint64 replaceMisses;\nuint64 inserts;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            output.present = state.get().table.get(input.key, locals.fetched) ? 1 : 0;
                            output.value = locals.fetched;
                            output.population = state.get().table.population();
                            output.replaceHits = state.get().replaceHits;
                            output.replaceMisses = state.get().replaceMisses;
                            output.inserts = state.get().inserts;
                        `,
                    },
                ],
                initialize: "state.mut().table.reset();\nstate.mut().replaceHits = 0;\nstate.mut().replaceMisses = 0;\nstate.mut().inserts = 0;",
            });
            const half = Math.max(1, capacity >> 1);
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(half), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(0) + u64(999), invocator: 0, note: "replace a present key" },
                    { kind: "function", entry: 1, in: u64(0) },
                    { kind: "procedure", entry: 2, in: u64(1000) + u64(7), invocator: 0, note: "replace an absent key — must not insert" },
                    { kind: "function", entry: 1, in: u64(1000) },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
