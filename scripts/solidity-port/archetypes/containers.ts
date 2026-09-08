// Container semantics at their boundaries.
//
// Ported from Solidity's `array` and `storage` semantic tests and from OpenZeppelin's EnumerableSet.
// Two QPI behaviours make these ports different from their originals, and both are named in the header
// comment of every emitted file: `Array::get(i)` masks the index (`i & (L-1)`) where Solidity reverts,
// and `HashMap::get` leaves the out-param untouched on a miss, so a read must pre-zero its destination.
// A HashMap also wraps rather than growing when it is full, so a Solidity mapping's unbounded growth
// becomes a capacity/fill question here.

import { emitContract } from "../emit";
import { capacityOf, fillCount } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

function churnSteps(capacity: number, fill: number): CallStep[] {
    const steps: CallStep[] = [];
    steps.push({ kind: "procedure", entry: 1, in: u64(fill), invocator: 0, note: `fill ${fill} of ${capacity}` });
    steps.push({ kind: "function", entry: 1 });
    steps.push({ kind: "procedure", entry: 2, in: u64(Math.max(1, fill >> 1)), invocator: 0, note: "remove half" });
    steps.push({ kind: "function", entry: 1 });
    steps.push({ kind: "procedure", entry: 1, in: u64(fill), invocator: 0, note: "refill — tombstone reuse" });
    steps.push({ kind: "function", entry: 1 });
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const CONTAINER_ARCHETYPES: Archetype[] = [
    {
        name: "MapFillChurnReuse",
        family: "containers",
        solidity: `${SOL}/storage/mapping_state.sol`,
        stresses: "HashMap fill to capacity, removal, and refill into the tombstones — the churn cycle where a slot-reuse bug shows up as a wrong population",
        caveat: "A Solidity mapping grows without bound; a QPI HashMap has a fixed power-of-two capacity and wraps when full.",
        axes: ["capacity", "fill"],
        build(axis: AxisAssignment) {
            const capacity = capacityOf(axis, 8);
            const fill = fillCount(axis, capacity);
            const source = emitContract({
                axis,
                name: "MapFillChurnReuse",
                header: {
                    archetype: "MapFillChurnReuse",
                    family: "containers",
                    solidity: `${SOL}/storage/mapping_state.sol`,
                    stresses: "fill / remove / refill against a fixed-capacity HashMap",
                    caveat: "HashMap::get leaves the out-param untouched on a miss, so every read here pre-zeroes it.",
                    axis: `capacity=${capacity} fill=${axis.fill ?? "half"}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> book;\nuint64 population;\nuint64 checksum;\nuint64 misses;`,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nuint64 fetched;\nuint64 total;\nuint64 missed;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                state.mut().book.set(locals.i, locals.i * 10 + 1);
                            }
                            locals.total = 0;
                            locals.missed = 0;
                            for (locals.i = 0; locals.i < ${capacity + 2}; locals.i++)
                            {
                                locals.fetched = 0;
                                if (state.get().book.get(locals.i, locals.fetched))
                                {
                                    locals.total += locals.fetched;
                                }
                                else
                                {
                                    locals.missed++;
                                }
                            }
                            state.mut().checksum = locals.total;
                            state.mut().misses = locals.missed;
                            state.mut().population = state.get().book.population();
                        `,
                    },
                    {
                        name: "Remove",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 count;",
                        locals: "uint64 i;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                state.mut().book.removeByKey(locals.i);
                            }
                            state.mut().population = state.get().book.population();
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 checksum;\nuint64 misses;",
                        body: `
                            output.population = state.get().population;
                            output.checksum = state.get().checksum;
                            output.misses = state.get().misses;
                        `,
                    },
                ],
                initialize: "state.mut().book.reset();\nstate.mut().population = 0;\nstate.mut().checksum = 0;\nstate.mut().misses = 0;",
            });
            return { source, script: script(churnSteps(capacity, fill)) };
        },
    },

    {
        name: "MapMissPreZeroed",
        family: "containers",
        solidity: `${SOL}/storage/mapping_state.sol`,
        stresses: "a HashMap miss with the destination pre-zeroed — Solidity's mapping default; the control for the un-zeroed form",
        caveat: "Solidity returns the type's default on a missing key; QPI leaves the out-param untouched, so the port must zero it first.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "MapMissPreZeroed",
                header: {
                    archetype: "MapMissPreZeroed",
                    family: "containers",
                    solidity: `${SOL}/storage/mapping_state.sol`,
                    stresses: "pre-zeroed miss vs hit on the same map",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> book;\nuint64 hitValue;\nuint64 missValue;\nuint64 hitFlag;\nuint64 missFlag;`,
                entries: [
                    {
                        name: "Probe",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;",
                        locals: "uint64 fetched;",
                        body: `
                            state.mut().book.set(input.key, input.key + 77);
                            locals.fetched = 0;
                            state.mut().hitFlag = state.get().book.get(input.key, locals.fetched) ? 1 : 0;
                            state.mut().hitValue = locals.fetched;
                            locals.fetched = 0;
                            state.mut().missFlag = state.get().book.get(input.key + 1000000, locals.fetched) ? 1 : 0;
                            state.mut().missValue = locals.fetched;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 hitValue;\nuint64 missValue;\nuint64 hitFlag;\nuint64 missFlag;",
                        body: `
                            output.hitValue = state.get().hitValue;
                            output.missValue = state.get().missValue;
                            output.hitFlag = state.get().hitFlag;
                            output.missFlag = state.get().missFlag;
                        `,
                    },
                ],
                initialize: "state.mut().book.reset();\nstate.mut().hitValue = 0;\nstate.mut().missValue = 0;\nstate.mut().hitFlag = 0;\nstate.mut().missFlag = 0;",
            });
            const steps: CallStep[] = [];
            for (const key of [0n, 1n, 7n, 18446744073709551615n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(key), invocator: 0, note: `key ${key}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "ArrayIndexMasked",
        family: "containers",
        solidity: `${SOL}/array/array_index_out_of_bounds.sol`,
        stresses: "an index at, one past, and far past capacity — QPI masks with (i & (L-1)) where Solidity reverts, so the write lands on a live element",
        caveat: "The Solidity original expects a revert. The QPI port asserts the masking behaviour instead: this is a semantics difference, not a bug.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "ArrayIndexMasked",
                header: {
                    archetype: "ArrayIndexMasked",
                    family: "containers",
                    solidity: `${SOL}/array/array_index_out_of_bounds.sol`,
                    stresses: "index masking rather than bounds-trapping",
                    caveat: "Solidity reverts on an out-of-bounds index; Array::get masks it.",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> slots;\nuint64 readBack;\nuint64 checksum;`,
                entries: [
                    {
                        name: "Poke",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;\nuint64 value;",
                        locals: "uint64 i;\nuint64 total;",
                        body: `
                            state.mut().slots.set(input.index, input.value);
                            state.mut().readBack = state.get().slots.get(input.index);
                            locals.total = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.total += state.get().slots.get(locals.i);
                            }
                            state.mut().checksum = locals.total;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 readBack;\nuint64 checksum;",
                        body: "output.readBack = state.get().readBack;\noutput.checksum = state.get().checksum;",
                    },
                ],
                initialize: "state.mut().slots.setAll(0);\nstate.mut().readBack = 0;\nstate.mut().checksum = 0;",
            });
            const steps: CallStep[] = [];
            for (const [index, value] of [
                [0n, 11n],
                [BigInt(capacity - 1), 22n],
                [BigInt(capacity), 33n],
                [BigInt(capacity + 1), 44n],
                [18446744073709551615n, 55n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(index) + u64(value), invocator: 0, note: `index ${index} of ${capacity}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "SetAddDuplicateRemoveMissing",
        family: "containers",
        solidity: "OpenZeppelin EnumerableSet",
        stresses: "adding a duplicate and removing an absent element from a HashSet — the two no-ops whose population accounting is easy to get wrong",
        axes: ["capacity", "fill"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const fill = fillCount(axis, capacity);
            const source = emitContract({
                axis,
                name: "SetAddDuplicateRemoveMissing",
                header: {
                    archetype: "SetAddDuplicateRemoveMissing",
                    family: "containers",
                    solidity: "OpenZeppelin EnumerableSet.add/remove",
                    stresses: "duplicate add and absent remove against a fixed-capacity HashSet",
                    axis: `capacity=${capacity} fill=${axis.fill ?? "half"}`,
                },
                state: `HashSet<uint64, ${capacity}> members;\nuint64 population;\nuint64 containsHit;\nuint64 containsMiss;`,
                entries: [
                    {
                        name: "Churn",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                state.mut().members.add(locals.i);
                                state.mut().members.add(locals.i);
                            }
                            state.mut().members.remove(1000000);
                            state.mut().containsHit = state.get().members.contains(0) ? 1 : 0;
                            state.mut().containsMiss = state.get().members.contains(1000000) ? 1 : 0;
                            state.mut().population = state.get().members.population();
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 containsHit;\nuint64 containsMiss;",
                        body: `
                            output.population = state.get().population;
                            output.containsHit = state.get().containsHit;
                            output.containsMiss = state.get().containsMiss;
                        `,
                    },
                ],
                initialize: "state.mut().members.reset();\nstate.mut().population = 0;\nstate.mut().containsHit = 0;\nstate.mut().containsMiss = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(fill), invocator: 0, note: `add ${fill} twice each` },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(capacity), invocator: 0, note: "to capacity" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "BitArrayPattern",
        family: "containers",
        solidity: `${SOL}/array/bytes_length_member.sol`,
        stresses: "setAll then individual bit writes — the word-boundary cases in a BitArray",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 64);
            const source = emitContract({
                axis,
                name: "BitArrayPattern",
                header: {
                    archetype: "BitArrayPattern",
                    family: "containers",
                    solidity: `${SOL}/array/bytes_length_member.sol`,
                    stresses: "BitArray word boundaries",
                    axis: `capacity=${capacity}`,
                },
                state: `BitArray<${capacity}> bits;\nuint64 setCount;\nuint64 firstSet;`,
                entries: [
                    {
                        name: "Pattern",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 stride;",
                        locals: "uint64 i;\nuint64 count;",
                        body: `
                            state.mut().bits.setAll(0);
                            locals.count = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                if (QPI::mod(locals.i, input.stride + 1) == 0)
                                {
                                    state.mut().bits.set(locals.i, 1);
                                    locals.count++;
                                }
                            }
                            state.mut().setCount = locals.count;
                            state.mut().firstSet = (uint64)state.get().bits.get(0);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 setCount;\nuint64 firstSet;",
                        body: "output.setCount = state.get().setCount;\noutput.firstSet = state.get().firstSet;",
                    },
                ],
                initialize: "state.mut().bits.setAll(0);\nstate.mut().setCount = 0;\nstate.mut().firstSet = 0;",
            });
            const steps: CallStep[] = [];
            for (const stride of [0n, 1n, 7n, 63n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(stride), invocator: 0, note: `every ${stride + 1n}th bit` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "NestedMappingTwoLevel",
        family: "containers",
        solidity: `${SOL}/storage/mapping_of_mapping.sol`,
        stresses: "a two-level lookup built as a HashMap keyed by a combined key — the ERC20 allowance shape",
        caveat: "QPI has no HashMap of HashMap in a state field of this shape, so the two levels are folded into one key via K12, as a real port would.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 64);
            const source = emitContract({
                axis,
                name: "NestedMappingTwoLevel",
                header: {
                    archetype: "NestedMappingTwoLevel",
                    family: "containers",
                    solidity: `${SOL}/storage/mapping_of_mapping.sol`,
                    stresses: "a folded two-level mapping key",
                    caveat: "mapping(a => mapping(b => c)) is folded to a single combined key.",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> allowances;\nuint64 population;\nuint64 fetched;`,
                entries: [
                    {
                        name: "Approve",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 owner;\nuint64 spender;\nuint64 amount;",
                        locals: "uint64 key;\nuint64 value;",
                        body: `
                            locals.key = input.owner * 1000003 + input.spender;
                            state.mut().allowances.set(locals.key, input.amount);
                            locals.value = 0;
                            state.get().allowances.get(locals.key, locals.value);
                            state.mut().fetched = locals.value;
                            state.mut().population = state.get().allowances.population();
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 fetched;",
                        body: "output.population = state.get().population;\noutput.fetched = state.get().fetched;",
                    },
                ],
                initialize: "state.mut().allowances.reset();\nstate.mut().population = 0;\nstate.mut().fetched = 0;",
            });
            const steps: CallStep[] = [];
            for (const [owner, spender, amount] of [
                [1n, 2n, 100n],
                [1n, 3n, 200n],
                [2n, 1n, 300n],
                [1n, 2n, 0n],
            ] as [bigint, bigint, bigint][]) {
                steps.push({
                    kind: "procedure",
                    entry: 1,
                    in: u64(owner) + u64(spender) + u64(amount),
                    invocator: 0,
                    note: `${owner} -> ${spender} = ${amount}`,
                });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },
];
