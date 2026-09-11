// HashMap and HashSet removal: tombstones, the removal counter, and cleanup's three exits.
import { emitContract } from "../emit";
import { u64 } from "../encode";
import { describeAxis, script } from "./common";
import type { Archetype, AxisAssignment, BuiltContract, CallStep } from "../types";

/** twoOperandArchetype derives Read and INITIALIZE from every state member, which needs them all uint64 —
 *  but the container has to stay in StateData to reach the digest. So this shape is hand-rolled. */
interface HashProbeSpec {
    /** The container declaration, e.g. `HashMap<id, uint64, 8> map;`. Excluded from `Read`. */
    container: string;
    /** The member to call reset() on in INITIALIZE. */
    containerName: string;
    /** uint64 members the body writes; these alone form the `Read` output, in declaration order. */
    state: string;
    body: string;
    locals: string;
    pairs: [bigint, bigint][];
    expect?: { pair: number; values: bigint[]; note: string }[];
}

function hashProbe(meta: Omit<Archetype, "build">, spec: (axis: AxisAssignment) => HashProbeSpec): Archetype {
    return {
        ...meta,
        build(axis: AxisAssignment): BuiltContract {
            const shape = spec(axis);
            const members = shape.state
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .map((line) => line.replace(/;$/, "").split(/\s+/).slice(-1)[0]!);
            const readBack = `${shape.state.trim()}\nuint64 calls;`;
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: describeAxis(axis),
                },
                state: `${shape.container.trim()}\n${readBack}`,
                entries: [
                    {
                        name: "Run",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 a;\nuint64 b;",
                        locals: shape.locals,
                        body: `${shape.body}\nstate.mut().calls++;`,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: readBack,
                        body: [...members.map((m) => `output.${m} = state.get().${m};`), "output.calls = state.get().calls;"].join("\n"),
                    },
                ],
                initialize: [`state.mut().${shape.containerName}.reset();`, ...members.map((m) => `state.mut().${m} = 0;`), "state.mut().calls = 0;"].join(
                    "\n",
                ),
            });
            const steps: CallStep[] = [];
            for (const [a, b] of shape.pairs) {
                steps.push({ kind: "procedure", entry: 1, in: u64(a) + u64(b), invocator: 0, note: `${a} , ${b}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            const built = script(steps);
            if (shape.expect) {
                built.expect = shape.expect.map((row) => ({
                    step: row.pair * 2 + 1,
                    out: [...row.values, BigInt(row.pair + 1)].map((value) => u64(value)).join(""),
                    source: "cpp-rule" as const,
                    note: row.note,
                }));
            }
            return { source, script: built };
        },
    };
}

const IMPL = "src/qpi/impl/qpi_hash_map_impl.h";
const OZ = "openzeppelin-contracts/contracts/utils/structs";

/** NULL_INDEX is sint64 -1 (qpi_types.h:24); these archetypes read it back through a uint64 member. */
const NULL_INDEX = 18446744073709551615n;

/** Three keys whose low word is 0, 8 and 16, so on an 8-slot map all three hash to slot 0. The reset() is
 *  load-bearing: Run is invoked once per pair, so without it counters accumulate across rows. */
const CHAIN_AT_ZERO = `
    state.mut().map.reset();
    locals.k0 = id(0, 0, 0, 0);
    locals.k8 = id(8, 0, 0, 0);
    locals.k16 = id(16, 0, 0, 0);
    state.mut().map.set(locals.k0, 100);
    state.mut().map.set(locals.k8, 200);
    state.mut().map.set(locals.k16, 300);
`;

/** The same shape one slot over, so slot 0 stays free and NULL_ID is not one of the keys. */
const CHAIN_AT_ONE = `
    locals.k1 = id(1, 0, 0, 0);
    locals.k9 = id(9, 0, 0, 0);
    locals.k17 = id(17, 0, 0, 0);
`;

export const HASH_REMOVAL_ARCHETYPES: Archetype[] = [
    hashProbe(
        {
            name: "HashMapTombstoneChainTraversal",
            family: "containers",
            solidity: `${OZ}/EnumerableMap.sol (remove from the middle of a bucket)`,
            stresses:
                "deleting one link of a linear-probe chain and then looking up the links past it — the tombstone exists precisely so this keeps working, and the probe must stop at a never-occupied slot but walk through a removed one",
            caveat: "EnumerableMap swaps the last entry into the hole and shrinks; QPI cannot, because that would relocate a key away from its probe position, so it marks instead.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            container: "HashMap<id, uint64, 8> map;",
            containerName: "map",
            state: "uint64 idx0;\nuint64 idx8;\nuint64 idx16;\nuint64 emptyAtTarget;\nuint64 population;",
            locals: "id k0;\nid k8;\nid k16;\nsint64 target;",
            body: `
                ${CHAIN_AT_ZERO}
                locals.target = input.a;
                state.mut().map.removeByIndex(locals.target);
                state.mut().idx0 = state.get().map.getElementIndex(locals.k0);
                state.mut().idx8 = state.get().map.getElementIndex(locals.k8);
                state.mut().idx16 = state.get().map.getElementIndex(locals.k16);
                state.mut().emptyAtTarget = state.get().map.isEmptySlot(locals.target) ? 1 : 0;
                state.mut().population = state.get().map.population();
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [2n, 0n],
                [7n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [NULL_INDEX, 1n, 2n, 1n, 2n],
                    note: `keys 0, 8 and 16 all hash to slot 0 (${IMPL}:26 — the id hash is the low word), so they occupy slots 0, 1 and 2. Removing slot 0 tombstones the chain head: looking up key 0 walks 0 (0b10, no case 2 at ${IMPL}:66, so it continues), 1 and 2 (occupied, wrong key), then 3 (0b00) and returns NULL_INDEX. The other two are still found at 1 and 2. isEmptySlot returns true for a tombstone (${IMPL}:182 tests != 1), and population is 2.`,
                },
                {
                    pair: 1,
                    values: [0n, NULL_INDEX, 2n, 1n, 2n],
                    note: "removing the middle link is the case the tombstone exists for: key 16 is still reached at slot 2 because the probe walks through slot 1 rather than stopping there. Key 8 itself is gone.",
                },
                {
                    pair: 2,
                    values: [0n, 1n, NULL_INDEX, 1n, 2n],
                    note: "removing the tail leaves the two links before it untouched; the probe for key 16 now runs 0, 1, 2 (tombstone), 3 (empty) and gives up.",
                },
                {
                    pair: 3,
                    values: [0n, 1n, 2n, 1n, 3n],
                    note: `slot 7 was never occupied, so removeByIndex's "(flags & 3) == 1" guard (${IMPL}:229) fails and the call is a no-op — population stays 3 and no counter moves. isEmptySlot is still true there, because 0b00 and 0b10 are indistinguishable to it.`,
                },
            ],
        }),
    ),

    hashProbe(
        {
            name: "HashMapRemoveByIndexMasksItsArgument",
            family: "containers",
            solidity: `${OZ}/EnumerableMap.sol (index bounds on removal)`,
            stresses:
                "removeByIndex masks its argument with (L-1) and never validates it, so an out-of-range or negative index is a silent alias for an in-range slot rather than an error",
            caveat: "The Solidity original reverts on an out-of-bounds index; QPI wraps, so the port asks which slot the wrap actually selects.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            container: "HashMap<id, uint64, 8> map;",
            containerName: "map",
            state: "uint64 population;\nuint64 emptyAtZero;\nuint64 emptyAtSeven;",
            locals: "id k0;\nid k8;\nid k16;\nsint64 target;",
            body: `
                ${CHAIN_AT_ZERO}
                locals.target = input.a;
                state.mut().map.removeByIndex(locals.target);
                state.mut().population = state.get().map.population();
                state.mut().emptyAtZero = state.get().map.isEmptySlot(0) ? 1 : 0;
                state.mut().emptyAtSeven = state.get().map.isEmptySlot(7) ? 1 : 0;
            `,
            pairs: [
                [8n, 0n],
                [18446744073709551615n, 0n],
                [1099511627776n, 0n],
                [3n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [2n, 1n, 1n],
                    note: `${IMPL}:229 begins with "elementIdx &= (L - 1)". On an 8-slot map index 8 masks to 0, so this deletes the chain head that a bounds check would have rejected. Slot 7 was never occupied and still reads empty.`,
                },
                {
                    pair: 1,
                    values: [3n, 0n, 1n],
                    note: "the operand arrives as sint64 -1, whose two's-complement form is all ones, so the mask selects slot 7. Nothing occupies slot 7, so the occupancy guard makes the whole call a no-op and population stays 3 — a negative index is neither an error nor, here, a deletion.",
                },
                {
                    pair: 2,
                    values: [2n, 1n, 1n],
                    note: "2^40 masks to 0 for the same reason as index 8: every index congruent to 0 modulo 8 aliases the chain head, however far out of range it is.",
                },
                {
                    pair: 3,
                    values: [3n, 0n, 1n],
                    note: "index 3 is in range but unoccupied, so the guard makes it a no-op — the same observable outcome as the wildly out-of-range index above, which is what makes the missing bounds check hard to notice.",
                },
            ],
        }),
    ),

    hashProbe(
        {
            name: "HashMapRemovalCounterCountsRemovalsNotTombstones",
            family: "containers",
            solidity: `${OZ}/EnumerableMap.sol (repeated add/remove of one key)`,
            stresses:
                "_markRemovalCounter is deliberately not decremented when a tombstone is reused, so churning one key drives a map with zero tombstones into needing a cleanup it cannot benefit from",
            caveat: "The Solidity original's set has no cleanup notion at all; this is a QPI-specific bookkeeping property with no Solidity counterpart.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            container: "HashMap<id, uint64, 8> map;",
            containerName: "map",
            state: "uint64 population;\nuint64 needsFifty;\nuint64 needsZero;\nuint64 emptyAtZero;",
            locals: "id k0;\nuint64 i;\nsint64 removed;",
            body: `
                state.mut().map.reset();
                locals.k0 = id(0, 0, 0, 0);
                state.mut().map.set(locals.k0, 1);
                for (locals.i = 0; locals.i < input.a; locals.i++)
                {
                    locals.removed = state.mut().map.removeByKey(locals.k0);
                    state.mut().map.set(locals.k0, 2);
                }
                state.mut().population = state.get().map.population();
                state.mut().needsFifty = state.get().map.needsCleanup(50) ? 1 : 0;
                state.mut().needsZero = state.get().map.needsCleanup(0) ? 1 : 0;
                state.mut().emptyAtZero = state.get().map.isEmptySlot(0) ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [4n, 0n],
                [5n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [1n, 0n, 0n, 0n],
                    note: `no churn: the counter is 0, and needsCleanup is a strict "> threshold" (${IMPL}:264), so even a threshold of 0 is not exceeded. The single key occupies slot 0.`,
                },
                {
                    pair: 1,
                    values: [1n, 0n, 1n, 0n],
                    note: `one remove-then-reinsert cycle. set() finds the 0b10 slot, reuses it via the goto at ${IMPL}:128, and the comment there is explicit that _markRemovalCounter is left alone so cleanup still looks needed. So the counter is 1 with no tombstone anywhere: needsCleanup(0) is true, needsCleanup(50) — threshold 50*8/100 = 4 — is not.`,
                },
                {
                    pair: 2,
                    values: [1n, 0n, 1n, 0n],
                    note: "four cycles put the counter exactly on the threshold of 4, and the comparison is strict, so 4 > 4 is false and a 50% cleanup is still not called for.",
                },
                {
                    pair: 3,
                    values: [1n, 1n, 1n, 0n],
                    note: "the fifth cycle takes the counter past the threshold and needsCleanup(50) becomes true — on a map holding exactly one element, in one slot, with zero slots marked for removal. The counter measures removals since the last cleanup, not tombstones outstanding.",
                },
            ],
        }),
    ),

    hashProbe(
        {
            name: "HashMapCleanupThreeExits",
            family: "containers",
            solidity: `${OZ}/EnumerableMap.sol (compaction after removals)`,
            stresses:
                "cleanup() has three quite different exits — an immediate return when nothing was removed, a whole-object reset when everything was, and a scratchpad rehash otherwise — and the rehash moves surviving keys to new slots",
            caveat: "No Solidity equivalent: this is QPI's answer to tombstone accumulation, and the reset path is the one that changes bytes the digest can see.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            container: "HashMap<id, uint64, 8> map;",
            containerName: "map",
            state: "uint64 population;\nuint64 idx0;\nuint64 idx16;\nuint64 needsZero;",
            locals: "id k0;\nid k8;\nid k16;\nsint64 removed;",
            body: `
                ${CHAIN_AT_ZERO}
                if (input.a == 1)
                {
                    locals.removed = state.mut().map.removeByKey(locals.k0);
                    locals.removed = state.mut().map.removeByKey(locals.k8);
                    locals.removed = state.mut().map.removeByKey(locals.k16);
                }
                if (input.a == 2)
                {
                    locals.removed = state.mut().map.removeByKey(locals.k8);
                }
                state.mut().map.cleanup();
                state.mut().population = state.get().map.population();
                state.mut().idx0 = state.get().map.getElementIndex(locals.k0);
                state.mut().idx16 = state.get().map.getElementIndex(locals.k16);
                state.mut().needsZero = state.get().map.needsCleanup(0) ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [2n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [3n, 0n, 2n, 0n],
                    note: `nothing was removed, so cleanup takes the "if (!_markRemovalCounter) return" exit at ${IMPL}:286 and does not allocate a scratchpad at all. The chain is untouched at slots 0, 1, 2.`,
                },
                {
                    pair: 1,
                    values: [0n, NULL_INDEX, NULL_INDEX, 0n],
                    note: `with every element removed, population() is 0 and cleanup takes the reset() exit (${IMPL}:292), which is setMem over the whole object — elements, flags, population and the counter all return to their constructed state, so neither key is found and no cleanup is outstanding.`,
                },
                {
                    pair: 2,
                    values: [2n, 0n, 1n, 0n],
                    note: "one removal leaves survivors, so cleanup does the full rehash. It walks the old slots in index order and reinserts into a fresh buffer: key 0 goes back to slot 0, then key 16 hashes to 0, finds it taken and lands at slot 1 — the slot the removed key 8 used to hold. Compaction is observable as a moved index, and the counter is zeroed so nothing further is needed.",
                },
            ],
        }),
    ),

    hashProbe(
        {
            name: "HashMapKeyAndValueIgnoreOccupancy",
            family: "containers",
            solidity: `${OZ}/EnumerableMap.sol (reading a slot by index)`,
            stresses:
                "key() and value() mask the index and return whatever is in the slot without consulting the occupation flags, and removeByIndex zeroes the element it marks — so a removed slot reads back as a zero key with a zero value rather than as an error",
            caveat: "The Solidity original's at() reverts past the end; QPI's accessors are documented as valid only when isEmptySlot is false, and this measures what they do when it is not.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            container: "HashMap<id, uint64, 8> map;",
            containerName: "map",
            state: "uint64 valueAtOne;\nuint64 valueAtTwo;\nuint64 keyZeroedAtOne;\nuint64 population;",
            locals: "id k1;\nid k9;\nid k17;\nsint64 target;",
            body: `
                state.mut().map.reset();
                ${CHAIN_AT_ONE}
                state.mut().map.set(locals.k1, 100);
                state.mut().map.set(locals.k9, 200);
                state.mut().map.set(locals.k17, 300);
                locals.target = input.a;
                state.mut().map.removeByIndex(locals.target);
                state.mut().valueAtOne = state.get().map.value(1);
                state.mut().valueAtTwo = state.get().map.value(2);
                state.mut().keyZeroedAtOne = (state.get().map.key(1) == NULL_ID) ? 1 : 0;
                state.mut().population = state.get().map.population();
            `,
            pairs: [
                [1n, 0n],
                [2n, 0n],
                [5n, 0n],
                [9n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [0n, 200n, 1n, 2n],
                    note: `keys 1, 9 and 17 hash to slot 1 and chain into 1, 2, 3. removeByIndex zeroes the element with setMem (${IMPL}:241, under a CLEAR_UNUSED_ELEMENT that is a compile-time true), so slot 1 reads back as the null id with value 0 — not as the key it held. value() (${IMPL}:98) never looks at the flags.`,
                },
                {
                    pair: 1,
                    values: [100n, 0n, 0n, 2n],
                    note: "removing slot 2 instead leaves slot 1 intact, so the two reads swap roles: the surviving slot still answers 100 and the removed one answers 0.",
                },
                {
                    pair: 2,
                    values: [100n, 200n, 0n, 3n],
                    note: "slot 5 is unoccupied, so the guard makes the removal a no-op and both slots read their stored values. This is the control that shows the zeroes above come from the removal rather than from the accessor.",
                },
                {
                    pair: 3,
                    values: [0n, 200n, 1n, 2n],
                    note: "index 9 masks to 1 on an 8-slot map, so this is byte-for-byte the pair-0 outcome reached through an out-of-range index — the accessors mask exactly as removeByIndex does.",
                },
            ],
        }),
    ),

    hashProbe(
        {
            name: "HashMapNeedsCleanupThresholdTruncates",
            family: "containers",
            solidity: `${OZ}/EnumerableMap.sol (load-factor policy)`,
            stresses:
                "needsCleanup computes its threshold as percent * L / 100 in unsigned integer arithmetic, so on a small map the truncation keeps the threshold at zero for every percentage below 13 and the predicate fires on the very first removal",
            caveat: "A pure QPI policy question with no Solidity counterpart; the interest is that the same percentage means different things at different capacities.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            container: "HashMap<id, uint64, 8> map;",
            containerName: "map",
            state: "uint64 needs;\nuint64 population;",
            locals: "id k0;\nid k8;\nid k16;\nsint64 removed;",
            body: `
                ${CHAIN_AT_ZERO}
                locals.removed = state.mut().map.removeByKey(locals.k8);
                state.mut().needs = state.get().map.needsCleanup(input.a) ? 1 : 0;
                state.mut().population = state.get().map.population();
            `,
            pairs: [
                [0n, 0n],
                [10n, 0n],
                [12n, 0n],
                [13n, 0n],
                [50n, 0n],
                [100n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 2n], note: `${IMPL}:264 — threshold 0*8/100 = 0, and one removal is > 0, so a zero percentage means "clean up after any removal at all".` },
                { pair: 1, values: [1n, 2n], note: "10*8 = 80, and 80/100 truncates to 0, so a nominal 10% policy behaves identically to 0% on an 8-slot map." },
                { pair: 2, values: [1n, 2n], note: "12*8 = 96, still under 100, so the threshold is still 0 — the last percentage at which that is true." },
                { pair: 3, values: [0n, 2n], note: "13*8 = 104, which truncates to 1, and one removal is not > 1. A single percentage point flips the answer, because the threshold moves in whole slots." },
                { pair: 4, values: [0n, 2n], note: "50*8/100 = 4; one removal is far below it." },
                { pair: 5, values: [0n, 2n], note: "100*8/100 = 8, the full capacity, so a 100% policy never triggers on any map that is not entirely churn." },
            ],
        }),
    ),

    hashProbe(
        {
            name: "HashSetRemoveAndKeyByValue",
            family: "containers",
            solidity: `${OZ}/EnumerableSet.sol (remove and read back)`,
            stresses:
                "HashSet's deletion half — spelled remove() where HashMap spells removeByKey() — and its key() accessor, which returns by value where HashMap's returns by const reference, so the two go through different return conventions in the backend",
            caveat: "EnumerableSet's remove swaps and pops; QPI marks, so the surviving elements keep their slots rather than being relocated.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            container: "HashSet<id, 8> set;",
            containerName: "set",
            state: "uint64 idx1;\nuint64 idx9;\nuint64 idx17;\nuint64 population;\nuint64 keyOneIntact;",
            locals: "id k1;\nid k9;\nid k17;\nid target;\nsint64 removed;",
            body: `
                state.mut().set.reset();
                ${CHAIN_AT_ONE}
                state.mut().set.add(locals.k1);
                state.mut().set.add(locals.k9);
                state.mut().set.add(locals.k17);
                locals.target = id(input.a, 0, 0, 0);
                locals.removed = state.mut().set.remove(locals.target);
                state.mut().idx1 = state.get().set.getElementIndex(locals.k1);
                state.mut().idx9 = state.get().set.getElementIndex(locals.k9);
                state.mut().idx17 = state.get().set.getElementIndex(locals.k17);
                state.mut().population = state.get().set.population();
                state.mut().keyOneIntact = (state.get().set.key(1) == locals.k1) ? 1 : 0;
            `,
            pairs: [
                [1n, 0n],
                [9n, 0n],
                [17n, 0n],
                [25n, 0n],
            ],
            expect: [
                {
                    pair: 0,
                    values: [NULL_INDEX, 2n, 3n, 2n, 0n],
                    note: "the three keys chain into slots 1, 2, 3. Removing key 1 tombstones the head, so it is no longer found while the two behind it keep their slots — HashSet marks rather than relocating. key(1) now returns a zeroed id by value, so it no longer equals the key that was there.",
                },
                {
                    pair: 1,
                    values: [1n, NULL_INDEX, 3n, 2n, 1n],
                    note: "removing the middle leaves key 17 reachable at slot 3 through the tombstone, and slot 1 still holds key 1, so the by-value key() read matches.",
                },
                {
                    pair: 2,
                    values: [1n, 2n, NULL_INDEX, 2n, 1n],
                    note: "removing the tail affects neither of the earlier slots.",
                },
                {
                    pair: 3,
                    values: [1n, 2n, 3n, 3n, 1n],
                    note: "key 25 also hashes to slot 1, but it was never added: the probe walks slots 1, 2, 3, finds slot 4 unoccupied and returns NULL_INDEX, so remove() does nothing and the population stays 3.",
                },
            ],
        }),
    ),

    hashProbe(
        {
            name: "HashMapChurnThenCleanupIfNeeded",
            family: "containers",
            solidity: `${OZ}/EnumerableMap.sol (sustained add/remove churn)`,
            stresses:
                "a long churn driving removals, reuse and an eventual cleanupIfNeeded — the compound path, where the reuse goto, the threshold predicate and the scratchpad rehash all interact",
            caveat:
                "No expect rows: the surviving slot layout after a rehash depends on the order the old table is walked, and deriving it by hand across four capacities is exactly the arithmetic that produced 47 false violations in round 6. This rests on the two backends and the WAMR oracle.",
            axes: ["capacity", "placement"],
        },
        (axis) => ({
            container: `HashMap<id, uint64, ${axis.capacity ?? 8}> map;`,
            containerName: "map",
            state: "uint64 population;\nuint64 found;\nuint64 needsFifty;",
            locals: "id probe;\nuint64 i;\nsint64 removed;\nsint64 index;",
            body: `
                state.mut().map.reset();
                for (locals.i = 0; locals.i < input.a; locals.i++)
                {
                    locals.probe = id(locals.i, 0, 0, 0);
                    locals.index = state.mut().map.set(locals.probe, locals.i + 1);
                }
                for (locals.i = 0; locals.i < input.b; locals.i++)
                {
                    locals.probe = id(locals.i, 0, 0, 0);
                    locals.removed = state.mut().map.removeByKey(locals.probe);
                }
                state.mut().map.cleanupIfNeeded(50);
                state.mut().population = state.get().map.population();
                locals.probe = id(input.a - 1, 0, 0, 0);
                state.mut().found = (state.get().map.getElementIndex(locals.probe) >= 0) ? 1 : 0;
                state.mut().needsFifty = state.get().map.needsCleanup(50) ? 1 : 0;
            `,
            pairs: [
                [4n, 0n],
                [4n, 2n],
                [6n, 5n],
                [8n, 8n],
            ],
        }),
    ),
];
