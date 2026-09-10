// Lane 2 — the Collection methods no archetype had ever called.
//
// A grep of every archetype against `qpi_containers.h` found that `Collection` is the least-covered
// container in the corpus by a wide margin. One archetype (`CollectionPriorityQueueByPov`) used
// `add`, `headIndex(pov)`, `nextElementIndex`, `element` and `population()`. Everything else the
// container exposes had **zero** call sites anywhere in 411 archetypes:
//
//     pov()  priority()  tailIndex()  prevElementIndex()  population(pov)
//     headIndex(pov, maxPriority)  tailIndex(pov, minPriority)  capacity()
//
// That matters more here than for the flat containers. `Collection` is a set of priority queues
// keyed by point of view, and each queue is a **binary search tree** with parent/left/right indices
// that `add` and `remove` rebalance (`_rebuild`, `_moveElement`, `_updateParent`). The backward walk
// and the priority-bounded lookups exercise tree edges the forward walk never touches, and a wrong
// edge is a wrong digest rather than a crash.
//
// Ported from OpenZeppelin's DoubleEndedQueue and Solidity's `arrays/` ordering tests as far as the
// shape carries; neither has priorities or point-of-view partitioning, so these are shape-only.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const OZ = "openzeppelin-contracts/contracts/utils/structs";

const capacityOf = (axis: AxisAssignment, fallback: number): number => {
    const declared = Number(axis.capacity ?? fallback);
    return Number.isFinite(declared) && declared >= 8 ? Math.min(64, declared) : fallback;
};

/** Add three elements to one pov with out-of-order priorities, so the queue has to sort them. */
const SEED_STEPS: CallStep[] = [
    { kind: "procedure", entry: 1, in: `${u64(40n)}${u64(7n)}`, invocator: 0, note: "value 40 priority 7" },
    { kind: "procedure", entry: 1, in: `${u64(10n)}${u64(1n)}`, invocator: 0, note: "value 10 priority 1" },
    { kind: "procedure", entry: 1, in: `${u64(30n)}${u64(5n)}`, invocator: 0, note: "value 30 priority 5" },
    { kind: "procedure", entry: 1, in: `${u64(20n)}${u64(3n)}`, invocator: 0, note: "value 20 priority 3" },
];

export const COLLECTION_POV_ARCHETYPES: Archetype[] = [
    {
        name: "CollectionBackwardWalkByTailIndex",
        family: "containers",
        solidity: `${OZ}/DoubleEndedQueue.sol`,
        stresses:
            "the backward walk — tailIndex() then prevElementIndex() — which traverses BST edges the forward head-to-tail walk never follows; the two walks must visit the same elements in opposite order",
        caveat: "OpenZeppelin's DoubleEndedQueue pops from both ends but has no priorities, so only the two-directional traversal carries over.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "CollectionBackwardWalkByTailIndex",
                header: {
                    archetype: "CollectionBackwardWalkByTailIndex",
                    family: "containers",
                    solidity: `${OZ}/DoubleEndedQueue.sol`,
                    stresses: "tailIndex + prevElementIndex against headIndex + nextElementIndex",
                    caveat: "no priorities in the Solidity original",
                    axis: `capacity=${capacity}`,
                },
                state: `Collection<uint64, ${capacity}> queue;\nuint64 forwardFirst;\nuint64 forwardLast;\nuint64 backwardFirst;\nuint64 backwardLast;\nuint64 forwardCount;\nuint64 backwardCount;\nuint64 mismatched;`,
                entries: [
                    {
                        name: "Add",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;\nsint64 priority;",
                        locals: "sint64 index;",
                        body: "locals.index = state.mut().queue.add(SELF, input.value, input.priority);",
                    },
                    {
                        name: "WalkBoth",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 unused;",
                        locals: `sint64 index;\nuint64 guard;\nuint64 seen;\nuint64 firstSeen;\nuint64 lastSeen;`,
                        body: `
                            locals.index = state.get().queue.headIndex(SELF);
                            locals.guard = 0;
                            locals.seen = 0;
                            locals.firstSeen = 0;
                            locals.lastSeen = 0;
                            while (locals.index >= 0 && locals.guard < ${capacity * 2})
                            {
                                if (locals.seen == 0)
                                {
                                    locals.firstSeen = state.get().queue.element(locals.index);
                                }
                                locals.lastSeen = state.get().queue.element(locals.index);
                                locals.index = state.get().queue.nextElementIndex(locals.index);
                                locals.seen++;
                                locals.guard++;
                            }
                            state.mut().forwardFirst = locals.firstSeen;
                            state.mut().forwardLast = locals.lastSeen;
                            state.mut().forwardCount = locals.seen;

                            locals.index = state.get().queue.tailIndex(SELF);
                            locals.guard = 0;
                            locals.seen = 0;
                            locals.firstSeen = 0;
                            locals.lastSeen = 0;
                            while (locals.index >= 0 && locals.guard < ${capacity * 2})
                            {
                                if (locals.seen == 0)
                                {
                                    locals.firstSeen = state.get().queue.element(locals.index);
                                }
                                locals.lastSeen = state.get().queue.element(locals.index);
                                locals.index = state.get().queue.prevElementIndex(locals.index);
                                locals.seen++;
                                locals.guard++;
                            }
                            state.mut().backwardFirst = locals.firstSeen;
                            state.mut().backwardLast = locals.lastSeen;
                            state.mut().backwardCount = locals.seen;

                            // The two walks must cover the same elements and mirror each other's ends.
                            if (state.get().forwardCount != state.get().backwardCount)
                            {
                                state.mut().mismatched++;
                            }
                            if (state.get().forwardFirst != state.get().backwardLast)
                            {
                                state.mut().mismatched++;
                            }
                            if (state.get().forwardLast != state.get().backwardFirst)
                            {
                                state.mut().mismatched++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 forwardFirst;\nuint64 forwardLast;\nuint64 backwardFirst;\nuint64 backwardLast;\nuint64 forwardCount;\nuint64 backwardCount;\nuint64 mismatched;",
                        body: `
                            output.forwardFirst = state.get().forwardFirst;
                            output.forwardLast = state.get().forwardLast;
                            output.backwardFirst = state.get().backwardFirst;
                            output.backwardLast = state.get().backwardLast;
                            output.forwardCount = state.get().forwardCount;
                            output.backwardCount = state.get().backwardCount;
                            output.mismatched = state.get().mismatched;
                        `,
                    },
                ],
                initialize:
                    "state.mut().queue.reset();\nstate.mut().forwardFirst = 0;\nstate.mut().forwardLast = 0;\nstate.mut().backwardFirst = 0;\nstate.mut().backwardLast = 0;\nstate.mut().forwardCount = 0;\nstate.mut().backwardCount = 0;\nstate.mut().mismatched = 0;",
            });

            const built = script([
                ...SEED_STEPS,
                { kind: "procedure", entry: 2, in: u64(0n), invocator: 0, note: "walk both directions" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ]);
            built.expect = [
                {
                    step: 5,
                    out: [40n, 10n, 10n, 40n, 4n, 4n, 0n].map((value) => u64(value)).join(""),
                    source: "cpp-rule",
                    note: "the queue is ordered by DESCENDING priority - qpi_collection_impl.h:64 states 'head's priority > maxPriority >= tail's priority' - so with priorities 1,3,5,7 the head is 40 and the tail 10. The forward walk runs 40 -> 10 and the backward walk 10 -> 40; both counts are 4 and nothing mismatches.",
                },
            ];
            return { source, script: built };
        },
    },

    {
        name: "CollectionPovAndPriorityReadBack",
        family: "containers",
        solidity: `${OZ}/EnumerableMap.sol`,
        stresses:
            "pov() and priority() — reading back, from an element index, the point of view and priority the element was added under; both are stored inside the container's own bookkeeping rather than in the element",
        caveat: "EnumerableMap stores keys next to values; QPI's Collection keeps the pov and priority in its index structure, so this reads the container's metadata rather than a value.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "CollectionPovAndPriorityReadBack",
                header: {
                    archetype: "CollectionPovAndPriorityReadBack",
                    family: "containers",
                    solidity: `${OZ}/EnumerableMap.sol`,
                    stresses: "pov() and priority() read back through the element index",
                    caveat: "the Solidity original stores keys with values",
                    axis: `capacity=${capacity}`,
                },
                state: `Collection<uint64, ${capacity}> queue;\nuint64 headPriority;\nuint64 tailPriority;\nuint64 povMatches;\nuint64 povMismatches;\nuint64 prioritySum;`,
                entries: [
                    {
                        name: "Add",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;\nsint64 priority;",
                        locals: "sint64 index;",
                        body: "locals.index = state.mut().queue.add(SELF, input.value, input.priority);",
                    },
                    {
                        name: "Inspect",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 unused;",
                        locals: `sint64 index;\nuint64 guard;\nuint64 seen;\nid owner;\nsint64 priorityHere;`,
                        body: `
                            locals.index = state.get().queue.headIndex(SELF);
                            locals.guard = 0;
                            locals.seen = 0;
                            while (locals.index >= 0 && locals.guard < ${capacity * 2})
                            {
                                locals.owner = state.get().queue.pov(locals.index);
                                locals.priorityHere = state.get().queue.priority(locals.index);
                                if (locals.owner == SELF)
                                {
                                    state.mut().povMatches++;
                                }
                                else
                                {
                                    state.mut().povMismatches++;
                                }
                                if (locals.seen == 0)
                                {
                                    state.mut().headPriority = (uint64)locals.priorityHere;
                                }
                                state.mut().tailPriority = (uint64)locals.priorityHere;
                                state.mut().prioritySum += (uint64)locals.priorityHere;
                                locals.index = state.get().queue.nextElementIndex(locals.index);
                                locals.seen++;
                                locals.guard++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 headPriority;\nuint64 tailPriority;\nuint64 povMatches;\nuint64 povMismatches;\nuint64 prioritySum;",
                        body: `
                            output.headPriority = state.get().headPriority;
                            output.tailPriority = state.get().tailPriority;
                            output.povMatches = state.get().povMatches;
                            output.povMismatches = state.get().povMismatches;
                            output.prioritySum = state.get().prioritySum;
                        `,
                    },
                ],
                initialize:
                    "state.mut().queue.reset();\nstate.mut().headPriority = 0;\nstate.mut().tailPriority = 0;\nstate.mut().povMatches = 0;\nstate.mut().povMismatches = 0;\nstate.mut().prioritySum = 0;",
            });

            const built = script([
                ...SEED_STEPS,
                { kind: "procedure", entry: 2, in: u64(0n), invocator: 0, note: "read pov and priority back" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ]);
            built.expect = [
                {
                    step: 5,
                    out: [7n, 1n, 4n, 0n, 16n].map((value) => u64(value)).join(""),
                    source: "cpp-rule",
                    note: "the head is the GREATEST priority (7) and the tail the least (1); all four were added under SELF so there are 4 matches and 0 mismatches, and the sum 1+3+5+7 = 16 is order-independent",
                },
            ];
            return { source, script: built };
        },
    },

    {
        name: "CollectionPriorityBoundedLookup",
        family: "containers",
        solidity: `${OZ}/Checkpoints.sol`,
        stresses:
            "the two-argument headIndex(pov, maxPriority) and tailIndex(pov, minPriority) — a bounded search through the priority tree, which is the closest thing the container has to a range query",
        caveat: "Checkpoints does a binary search over a sorted array by block number; the shape (find the first entry at or under a bound) is what carries over.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "CollectionPriorityBoundedLookup",
                header: {
                    archetype: "CollectionPriorityBoundedLookup",
                    family: "containers",
                    solidity: `${OZ}/Checkpoints.sol`,
                    stresses: "priority-bounded headIndex and tailIndex",
                    caveat: "the Solidity original binary-searches a sorted array",
                    axis: `capacity=${capacity}`,
                },
                state: `Collection<uint64, ${capacity}> queue;\nuint64 atOrUnderFour;\nuint64 atOrOverFour;\nuint64 underEverything;\nuint64 overEverything;\nuint64 povPopulation;\nuint64 totalPopulation;`,
                entries: [
                    {
                        name: "Add",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;\nsint64 priority;",
                        locals: "sint64 index;",
                        body: "locals.index = state.mut().queue.add(SELF, input.value, input.priority);",
                    },
                    {
                        name: "Probe",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 unused;",
                        locals: "sint64 index;",
                        body: `
                            // Walking down from the head, the first element with priority <= 4 is the
                            // priority-3 one, so 20.
                            locals.index = state.get().queue.headIndex(SELF, 4);
                            state.mut().atOrUnderFour = locals.index >= 0 ? state.get().queue.element(locals.index) : 0;

                            // The last element with priority >= 4 is the priority-5 one, so 30.
                            locals.index = state.get().queue.tailIndex(SELF, 4);
                            state.mut().atOrOverFour = locals.index >= 0 ? state.get().queue.element(locals.index) : 0;

                            // maxPriority 0 is below every priority present, so nothing qualifies.
                            locals.index = state.get().queue.headIndex(SELF, 0);
                            state.mut().underEverything = locals.index >= 0 ? 1 : 0;

                            // minPriority 99 is above every priority present, so nothing qualifies.
                            locals.index = state.get().queue.tailIndex(SELF, 99);
                            state.mut().overEverything = locals.index >= 0 ? 1 : 0;

                            state.mut().povPopulation = state.get().queue.population(SELF);
                            state.mut().totalPopulation = state.get().queue.population();
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 atOrUnderFour;\nuint64 atOrOverFour;\nuint64 underEverything;\nuint64 overEverything;\nuint64 povPopulation;\nuint64 totalPopulation;",
                        body: `
                            output.atOrUnderFour = state.get().atOrUnderFour;
                            output.atOrOverFour = state.get().atOrOverFour;
                            output.underEverything = state.get().underEverything;
                            output.overEverything = state.get().overEverything;
                            output.povPopulation = state.get().povPopulation;
                            output.totalPopulation = state.get().totalPopulation;
                        `,
                    },
                ],
                initialize:
                    "state.mut().queue.reset();\nstate.mut().atOrUnderFour = 0;\nstate.mut().atOrOverFour = 0;\nstate.mut().underEverything = 0;\nstate.mut().overEverything = 0;\nstate.mut().povPopulation = 0;\nstate.mut().totalPopulation = 0;",
            });

            const built = script([
                ...SEED_STEPS,
                { kind: "procedure", entry: 2, in: u64(0n), invocator: 0, note: "bounded lookups" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ]);
            built.expect = [
                {
                    step: 5,
                    out: [20n, 30n, 0n, 0n, 4n, 4n].map((value) => u64(value)).join(""),
                    source: "cpp-rule",
                    note: "priorities 1,3,5,7 hold values 10,20,30,40 and the queue runs head-to-tail by DESCENDING priority. headIndex(SELF, 4) takes the first element with priority <= 4, which is priority 3 -> 20; tailIndex(SELF, 4) takes the last with priority >= 4, which is priority 5 -> 30. maxPriority 0 and minPriority 99 both fall outside the range, so each returns NULL_INDEX and stores 0. Both populations are 4.",
                },
            ];
            return { source, script: built };
        },
    },

    {
        name: "CollectionPopulationAcrossTwoPovs",
        family: "containers",
        solidity: `${OZ}/EnumerableSet.sol`,
        stresses:
            "population(pov) against population() with elements split across two points of view, so a bug that merges or double-counts the per-pov queues shows up as a wrong count rather than a wrong order",
        caveat: "EnumerableSet has one namespace per set instance; QPI partitions one Collection by pov, so the per-pov count is the analogue of a set's length.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "CollectionPopulationAcrossTwoPovs",
                header: {
                    archetype: "CollectionPopulationAcrossTwoPovs",
                    family: "containers",
                    solidity: `${OZ}/EnumerableSet.sol`,
                    stresses: "per-pov population against the total",
                    caveat: "one Collection partitioned by pov stands in for two sets",
                    axis: `capacity=${capacity}`,
                },
                state: `Collection<uint64, ${capacity}> queue;\nuint64 selfCount;\nuint64 otherCount;\nuint64 total;\nuint64 selfHead;\nuint64 otherHead;`,
                entries: [
                    {
                        name: "Add",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;\nsint64 priority;\nuint64 useSelf;",
                        locals: "sint64 index;\nid pov;",
                        body: `
                            locals.pov = input.useSelf == 0 ? qpi.invocator() : SELF;
                            locals.index = state.mut().queue.add(locals.pov, input.value, input.priority);
                        `,
                    },
                    {
                        name: "Count",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 unused;",
                        locals: "sint64 index;",
                        body: `
                            state.mut().selfCount = state.get().queue.population(SELF);
                            state.mut().otherCount = state.get().queue.population(qpi.invocator());
                            state.mut().total = state.get().queue.population();
                            locals.index = state.get().queue.headIndex(SELF);
                            state.mut().selfHead = locals.index >= 0 ? state.get().queue.element(locals.index) : 0;
                            locals.index = state.get().queue.headIndex(qpi.invocator());
                            state.mut().otherHead = locals.index >= 0 ? state.get().queue.element(locals.index) : 0;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 selfCount;\nuint64 otherCount;\nuint64 total;\nuint64 selfHead;\nuint64 otherHead;",
                        body: `
                            output.selfCount = state.get().selfCount;
                            output.otherCount = state.get().otherCount;
                            output.total = state.get().total;
                            output.selfHead = state.get().selfHead;
                            output.otherHead = state.get().otherHead;
                        `,
                    },
                ],
                initialize:
                    "state.mut().queue.reset();\nstate.mut().selfCount = 0;\nstate.mut().otherCount = 0;\nstate.mut().total = 0;\nstate.mut().selfHead = 0;\nstate.mut().otherHead = 0;",
            });

            const built = script([
                { kind: "procedure", entry: 1, in: `${u64(50n)}${u64(2n)}${u64(1n)}`, invocator: 0, note: "50 under SELF" },
                { kind: "procedure", entry: 1, in: `${u64(60n)}${u64(4n)}${u64(1n)}`, invocator: 0, note: "60 under SELF" },
                { kind: "procedure", entry: 1, in: `${u64(70n)}${u64(1n)}${u64(0n)}`, invocator: 0, note: "70 under the invocator" },
                { kind: "procedure", entry: 2, in: u64(0n), invocator: 0, note: "count both povs" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ]);
            built.expect = [
                {
                    step: 4,
                    out: [2n, 1n, 3n, 60n, 70n].map((value) => u64(value)).join(""),
                    source: "cpp-rule",
                    note: "two elements under SELF and one under the invocator: counts 2 and 1, total 3. Each pov's head is its own HIGHEST-priority element, so SELF's head is 60 (priority 4, over 50 at priority 2) and the invocator's is its only element, 70.",
                },
            ];
            return { source, script: built };
        },
    },
];
