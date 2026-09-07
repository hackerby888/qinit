// Contract lifecycle: construction, tick and epoch hooks.
//
// Ported from Solidity's `constructor`, `state` and `immutable` tests. Solidity's constructor becomes
// `INITIALIZE()`; there is no Solidity analogue for the tick and epoch hooks, but they are included
// because they run outside any user call, which is exactly where a codegen difference would be missed
// by a script that only ever invokes entries.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype } from "../types";

const SOL = "test/libsolidity/semanticTests";

export const LIFECYCLE_ARCHETYPES: Archetype[] = [
    {
        name: "InitializeSetsEveryField",
        family: "lifecycle",
        solidity: `${SOL}/constructor/constructor_state_value_parameters.sol`,
        stresses: "INITIALIZE writing every member kind — scalar, id, array and container — so a missed initialiser shows up as a different first digest",
        caveat: "Solidity constructors take arguments; INITIALIZE does not, so the values are constants.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                name: "InitializeSetsEveryField",
                header: {
                    archetype: "InitializeSetsEveryField",
                    family: "lifecycle",
                    solidity: `${SOL}/constructor/constructor_state_value_parameters.sol`,
                    stresses: "full construction-time initialisation",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 scalar;\nid owner;\nArray<uint64, 8> slots;\nHashMap<uint64, uint64, 8> book;\nuint64 initialised;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Touch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 fetched;",
                        body: `
                            state.mut().scalar += input.value;
                            state.mut().slots.set(0, input.value);
                            state.mut().book.set(input.value, input.value + 1);
                            locals.fetched = 0;
                            state.get().book.get(input.value, locals.fetched);
                            state.mut().initialised = locals.fetched;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 scalar;\nuint64 slotZero;\nuint64 population;\nuint64 initialised;",
                        body: `
                            output.scalar = state.get().scalar;
                            output.slotZero = state.get().slots.get(0);
                            output.population = state.get().book.population();
                            output.initialised = state.get().initialised;
                        `,
                    },
                ],
                initialize: `
                    state.mut().scalar = 7;
                    state.mut().owner = SELF;
                    state.mut().slots.setAll(3);
                    state.mut().book.reset();
                    state.mut().initialised = 1;
                `,
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1, note: "read before any procedure — pure construction state" },
                    { kind: "procedure", entry: 1, in: u64(5), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "TickAndEpochHooks",
        family: "lifecycle",
        solidity: "no Solidity analogue (block hooks)",
        stresses: "BEGIN_TICK, END_TICK, BEGIN_EPOCH and END_EPOCH — code that runs with no user call, where a script driving only entries would never look",
        caveat: "Solidity has no per-block hook. Included because hook code is the least-exercised path in a contract.",
        axes: [],
        build() {
            const source = emitContract({
                name: "TickAndEpochHooks",
                header: {
                    archetype: "TickAndEpochHooks",
                    family: "lifecycle",
                    solidity: "no Solidity analogue",
                    stresses: "the four lifecycle hooks",
                    axis: "base",
                },
                state: "uint64 beginTicks;\nuint64 endTicks;\nuint64 beginEpochs;\nuint64 endEpochs;\nuint64 userCalls;",
                entries: [
                    {
                        name: "Touch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: "state.mut().userCalls += input.value;",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 beginTicks;\nuint64 endTicks;\nuint64 beginEpochs;\nuint64 endEpochs;\nuint64 userCalls;",
                        body: `
                            output.beginTicks = state.get().beginTicks;
                            output.endTicks = state.get().endTicks;
                            output.beginEpochs = state.get().beginEpochs;
                            output.endEpochs = state.get().endEpochs;
                            output.userCalls = state.get().userCalls;
                        `,
                    },
                ],
                initialize: "state.mut().beginTicks = 0;\nstate.mut().endTicks = 0;\nstate.mut().beginEpochs = 0;\nstate.mut().endEpochs = 0;\nstate.mut().userCalls = 0;",
                beginTick: "state.mut().beginTicks++;",
                endTick: "state.mut().endTicks++;",
                beginEpoch: "state.mut().beginEpochs++;",
                endEpoch: "state.mut().endEpochs++;",
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 3 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(1), invocator: 0 },
                    { kind: "advanceEpoch", n: 1 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 2 },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    },

    {
        name: "FunctionMustNotMutate",
        family: "lifecycle",
        solidity: `${SOL}/state/state_variables_view.sol`,
        stresses: "a read-only function next to a mutating procedure — the negative control: the function's calls must leave the digest unchanged",
        caveat: "Solidity marks this `view`; QPI enforces it structurally, since a function has no state.mut().",
        axes: [],
        build() {
            const source = emitContract({
                name: "FunctionMustNotMutate",
                header: {
                    archetype: "FunctionMustNotMutate",
                    family: "lifecycle",
                    solidity: `${SOL}/state/state_variables_view.sol`,
                    stresses: "a function call must not move the state digest",
                    caveat: "negative control — a digest that moves across a function call is a finding on its own",
                    axis: "base",
                },
                state: "uint64 value;\nuint64 reads;",
                entries: [
                    {
                        name: "Set",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: "state.mut().value = input.value;",
                    },
                    {
                        name: "Get",
                        kind: "function",
                        number: 1,
                        output: "uint64 value;\nuint64 doubled;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = state.get().value;
                            output.value = locals.scratch;
                            output.doubled = locals.scratch * 2;
                        `,
                    },
                ],
                initialize: "state.mut().value = 0;\nstate.mut().reads = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(11), invocator: 0 },
                    { kind: "function", entry: 1, note: "digest must equal the previous step's" },
                    { kind: "function", entry: 1, note: "and again" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
