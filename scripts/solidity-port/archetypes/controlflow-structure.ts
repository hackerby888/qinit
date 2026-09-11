// Control flow whose *shape* is the test: nesting, early exit, evaluation order and call depth.

import { emitContract } from "../emit";
import { loopHeader } from "../axes";
import { script } from "./common";
import { pad, u32, u64, u8 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

/** Drive one uint64 procedure over a ladder of values and read after each. */
function ladder(values: bigint[]): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry: 1, in: u64(value), invocator: 0, note: `n=${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const CONTROLFLOW_STRUCTURE_ARCHETYPES: Archetype[] = [
    {
        name: "NestedLoopBreakContinue",
        family: "controlflow",
        solidity: `${SOL}/controlFlow/loops.sol`,
        stresses:
            "break and continue inside a two-level loop — the inner break must leave the outer loop running, which is where a mis-lowered branch target shows up",
        axes: ["loopShape", "placement"],
        build(axis) {
            const outer = loopHeader(axis, "locals.i", "input.n", 6);
            const source = emitContract({
                axis,
                name: "NestedLoopBreakContinue",
                header: {
                    archetype: "NestedLoopBreakContinue",
                    family: "controlflow",
                    solidity: `${SOL}/controlFlow/loops.sol`,
                    stresses: "break and continue at two nesting levels",
                    axis: "nested loop with early exits",
                },
                state: "uint64 visited;\nuint64 skipped;\nuint64 broken;\nuint64 product;",
                entries: [
                    {
                        name: "Walk",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 n;",
                        locals: "uint64 i;\nuint64 j;",
                        body: `
                            ${outer}
                            {
                                if (QPI::mod(locals.i, 3ULL) == 2)
                                {
                                    state.mut().skipped++;
                                    continue;
                                }
                                for (locals.j = 0; locals.j < 4; locals.j++)
                                {
                                    if (locals.j > locals.i)
                                    {
                                        state.mut().broken++;
                                        break;
                                    }
                                    state.mut().visited++;
                                    state.mut().product += locals.i * 4 + locals.j;
                                }
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 visited;\nuint64 skipped;\nuint64 broken;\nuint64 product;",
                        body: `
                            output.visited = state.get().visited;
                            output.skipped = state.get().skipped;
                            output.broken = state.get().broken;
                            output.product = state.get().product;
                        `,
                    },
                ],
                initialize: "state.mut().visited = 0;\nstate.mut().skipped = 0;\nstate.mut().broken = 0;\nstate.mut().product = 0;",
            });
            return { source, script: script(ladder([0n, 1n, 3n, 6n])) };
        },
    },

    {
        name: "EarlyReturnFromDeepNesting",
        family: "controlflow",
        solidity: `${SOL}/controlFlow/return_and_break.sol`,
        stresses:
            "a return four levels deep inside a loop inside two ifs — every enclosing scope has to be unwound and the partial writes before it must stand",
        caveat: "Solidity's early return leaves earlier storage writes in place; so does QPI's, and this pins that both backends agree on which writes happened.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EarlyReturnFromDeepNesting",
                header: {
                    archetype: "EarlyReturnFromDeepNesting",
                    family: "controlflow",
                    solidity: `${SOL}/controlFlow/return_and_break.sol`,
                    stresses: "returning out of four nested scopes with writes already committed",
                    caveat: "the writes before the return must survive",
                    axis: "deep early return",
                },
                state: "uint64 beforeReturn;\nuint64 afterReturn;\nuint64 returnedAt;\nuint64 completed;",
                entries: [
                    {
                        name: "Search",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 target;",
                        output: "uint64 found;",
                        locals: "uint64 i;\nuint64 j;",
                        body: `
                            state.mut().beforeReturn++;
                            if (input.target != 0)
                            {
                                if (input.target < 100)
                                {
                                    for (locals.i = 0; locals.i < 5; locals.i++)
                                    {
                                        for (locals.j = 0; locals.j < 5; locals.j++)
                                        {
                                            if (locals.i * 5 + locals.j == input.target)
                                            {
                                                state.mut().returnedAt = locals.i * 5 + locals.j;
                                                output.found = 1;
                                                return;
                                            }
                                        }
                                    }
                                }
                            }
                            state.mut().afterReturn++;
                            state.mut().completed++;
                            output.found = 0;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 beforeReturn;\nuint64 afterReturn;\nuint64 returnedAt;\nuint64 completed;",
                        body: `
                            output.beforeReturn = state.get().beforeReturn;
                            output.afterReturn = state.get().afterReturn;
                            output.returnedAt = state.get().returnedAt;
                            output.completed = state.get().completed;
                        `,
                    },
                ],
                initialize: "state.mut().beforeReturn = 0;\nstate.mut().afterReturn = 0;\nstate.mut().returnedAt = 0;\nstate.mut().completed = 0;",
            });
            return { source, script: script(ladder([0n, 7n, 24n, 25n, 200n])) };
        },
    },

    {
        name: "TernaryChainNarrowing",
        family: "controlflow",
        solidity: `${SOL}/expressions/conditional_expression_type.sol`,
        stresses:
            "a chain of conditional expressions whose arms have different widths — the common type is computed across the whole chain, then narrowed on the store",
        caveat: "The Solidity original checks the conditional's type against uint256; the port stores the same chain into an 8-bit and a 64-bit field so the narrowing is observable.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TernaryChainNarrowing",
                header: {
                    archetype: "TernaryChainNarrowing",
                    family: "controlflow",
                    solidity: `${SOL}/expressions/conditional_expression_type.sol`,
                    stresses: "the common type of a three-deep conditional chain",
                    caveat: "the result is stored at two widths so a promotion is visible",
                    axis: "conditional chain",
                },
                state: "uint64 wide;\nuint8 narrow;\nsint64 signedWide;\nuint64 calls;",
                entries: [
                    {
                        name: "Pick",
                        kind: "procedure",
                        number: 1,
                        input: "uint8 small;\nuint32 medium;\nuint64 large;",
                        locals: "uint64 chosen;",
                        body: `
                            locals.chosen = input.small > 100 ? (uint64)input.large : (input.medium > 1000 ? (uint64)input.medium : (uint64)input.small);
                            state.mut().wide = locals.chosen;
                            state.mut().narrow = (uint8)(input.small > 100 ? input.large : (input.medium > 1000 ? input.medium : input.small));
                            state.mut().signedWide = input.small > 100 ? -(sint64)input.large : (sint64)input.medium;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 wide;\nuint8 narrow;\nsint64 signedWide;\nuint64 calls;",
                        body: `
                            output.wide = state.get().wide;
                            output.narrow = state.get().narrow;
                            output.signedWide = state.get().signedWide;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().wide = 0;\nstate.mut().narrow = 0;\nstate.mut().signedWide = 0;\nstate.mut().calls = 0;",
            });
            const steps: CallStep[] = [];
            for (const [small, medium, large] of [
                [0, 0, 0n],
                [255, 4294967295, 18446744073709551615n],
                [50, 2000, 7n],
                [50, 3, 9n],
                [101, 1, 256n],
            ] as [number, number, bigint][]) {
                // uint8, three bytes of padding, uint32, uint64 — the struct as C++ lays it out.
                steps.push({
                    kind: "procedure",
                    entry: 1,
                    in: u8(small) + pad(3) + u32(medium) + u64(large),
                    invocator: 0,
                    note: `small=${small} medium=${medium} large=${large}`,
                });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "WhileLoopMutableBound",
        family: "controlflow",
        solidity: `${SOL}/controlFlow/while_loop.sol`,
        stresses: "a while loop whose bound is recomputed in the body — the trip count is unknowable to the compiler, so nothing may be unrolled or folded",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "WhileLoopMutableBound",
                header: {
                    archetype: "WhileLoopMutableBound",
                    family: "controlflow",
                    solidity: `${SOL}/controlFlow/while_loop.sol`,
                    stresses: "a loop bound the body changes",
                    axis: "while with mutable bound",
                },
                state: "uint64 iterations;\nuint64 remaining;\nuint64 accumulated;",
                entries: [
                    {
                        name: "Drain",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 step;",
                        locals: "uint64 budget;\nuint64 chunk;\nuint64 guard;",
                        body: `
                            locals.budget = input.amount;
                            locals.chunk = input.step == 0 ? 1 : input.step;
                            locals.guard = 0;
                            while (locals.budget > 0 && locals.guard < 64)
                            {
                                if (locals.budget < locals.chunk)
                                {
                                    locals.chunk = locals.budget;
                                }
                                locals.budget -= locals.chunk;
                                state.mut().accumulated += locals.chunk;
                                state.mut().iterations++;
                                locals.guard++;
                            }
                            state.mut().remaining = locals.budget;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 iterations;\nuint64 remaining;\nuint64 accumulated;",
                        body: `
                            output.iterations = state.get().iterations;
                            output.remaining = state.get().remaining;
                            output.accumulated = state.get().accumulated;
                        `,
                    },
                ],
                initialize: "state.mut().iterations = 0;\nstate.mut().remaining = 0;\nstate.mut().accumulated = 0;",
            });
            const steps: CallStep[] = [];
            for (const [amount, step] of [
                [0n, 3n],
                [10n, 3n],
                [7n, 0n],
                [1000n, 100n],
                [200n, 1n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount) + u64(step), invocator: 0, note: `${amount} in steps of ${step}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "DescendingLoopUnsignedGuard",
        family: "controlflow",
        solidity: `${SOL}/controlFlow/for_loop_decrement.sol`,
        stresses: "a descending loop over an unsigned counter — the classic `for (i = n; i > 0; i--)` versus the wrapping `i >= 0` spelling, both driven",
        caveat: "The wrapping spelling would never terminate, so the port bounds it with a guard counter and records how many times the guard fired.",
        axes: ["placement", "loopShape"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "DescendingLoopUnsignedGuard",
                header: {
                    archetype: "DescendingLoopUnsignedGuard",
                    family: "controlflow",
                    solidity: `${SOL}/controlFlow/for_loop_decrement.sol`,
                    stresses: "unsigned decrement to zero, and the index that wraps past it",
                    caveat: "the wrapping spelling is bounded by a guard so the contract terminates",
                    axis: "descending loop",
                },
                state: "uint64 safeVisits;\nuint64 wrappedVisits;\nuint64 lastIndex;\nuint64 guardFired;",
                entries: [
                    {
                        name: "Descend",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 n;",
                        locals: "uint64 i;\nuint8 small;\nuint64 guard;",
                        body: `
                            for (locals.i = input.n; locals.i > 0; locals.i--)
                            {
                                state.mut().safeVisits++;
                                state.mut().lastIndex = locals.i;
                            }
                            // The same descent at eight bits, where the decrement past zero wraps to 255.
                            locals.small = (uint8)input.n;
                            locals.guard = 0;
                            while (locals.guard < 40)
                            {
                                state.mut().wrappedVisits++;
                                locals.small--;
                                locals.guard++;
                                if (locals.small == 0)
                                {
                                    break;
                                }
                            }
                            if (locals.guard >= 40)
                            {
                                state.mut().guardFired++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 safeVisits;\nuint64 wrappedVisits;\nuint64 lastIndex;\nuint64 guardFired;",
                        body: `
                            output.safeVisits = state.get().safeVisits;
                            output.wrappedVisits = state.get().wrappedVisits;
                            output.lastIndex = state.get().lastIndex;
                            output.guardFired = state.get().guardFired;
                        `,
                    },
                ],
                initialize: "state.mut().safeVisits = 0;\nstate.mut().wrappedVisits = 0;\nstate.mut().lastIndex = 0;\nstate.mut().guardFired = 0;",
            });
            return { source, script: script(ladder([0n, 1n, 5n, 256n, 257n])) };
        },
    },

    {
        name: "PrivateCallDepthThree",
        family: "controlflow",
        solidity: `${SOL}/functionCall/inheritance_chain_call.sol`,
        stresses:
            "a three-deep chain of PRIVATE_FUNCTION calls, each with its own input, output and locals — three nested locals frames the arena has to lay out without overlapping",
        caveat: "Solidity's chain is a virtual dispatch through a base; QPI has no virtual calls, so the port chains private entries instead.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const level = (name: string, callee: string | null) => ({
                name,
                kind: "function" as const,
                visibility: "private" as const,
                number: 0,
                input: "uint64 value;",
                output: "uint64 result;",
                locals: callee ? `${callee}_input request;\n${callee}_output response;\nuint64 scratch;` : "uint64 scratch;",
                body: callee
                    ? `
                        locals.scratch = input.value + 1;
                        locals.request.value = locals.scratch;
                        CALL(${callee}, locals.request, locals.response);
                        output.result = locals.response.result * 2;
                      `
                    : `
                        locals.scratch = input.value * 3;
                        output.result = locals.scratch;
                      `,
            });
            const source = emitContract({
                axis,
                name: "PrivateCallDepthThree",
                header: {
                    archetype: "PrivateCallDepthThree",
                    family: "controlflow",
                    solidity: `${SOL}/functionCall/inheritance_chain_call.sol`,
                    stresses: "three nested private calls, each with its own locals frame",
                    caveat: "virtual dispatch becomes a private call chain",
                    axis: "call depth 3",
                },
                state: "uint64 lastResult;\nuint64 calls;",
                entries: [
                    // Named so the deepest sorts first: a helper whose locals name another helper's input
                    // type has to be emitted after it, and the emitter orders private entries by name.
                    level("LevelA", null),
                    level("LevelB", "LevelA"),
                    level("LevelC", "LevelB"),
                    {
                        name: "Run",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "LevelC_input request;\nLevelC_output response;",
                        body: `
                            locals.request.value = input.value;
                            CALL(LevelC, locals.request, locals.response);
                            state.mut().lastResult = locals.response.result;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 lastResult;\nuint64 calls;",
                        body: "output.lastResult = state.get().lastResult;\noutput.calls = state.get().calls;",
                    },
                ],
                initialize: "state.mut().lastResult = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(ladder([0n, 1n, 5n, 1000n])) };
        },
    },

    {
        name: "IncrementOrderInExpression",
        family: "controlflow",
        solidity: `${SOL}/expressions/order_of_evaluation.sol`,
        stresses:
            "pre- and post-increment of the same variable inside one expression, and an increment used as an array index — where the evaluation order the two backends pick becomes visible in state",
        caveat: "The Solidity original notes the order is unspecified there too; the port records the outcome rather than asserting one, so a divergence is reported as the two backends picking differently.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "IncrementOrderInExpression",
                header: {
                    archetype: "IncrementOrderInExpression",
                    family: "controlflow",
                    solidity: `${SOL}/expressions/order_of_evaluation.sol`,
                    stresses: "pre/post increment inside one expression and as an index",
                    caveat: "the order is unspecified in both languages; this records which one each backend picks",
                    axis: "evaluation order",
                },
                state: "uint64 sum;\nuint64 counter;\nArray<uint64, 8> slots;\nuint64 indexAfter;",
                entries: [
                    {
                        name: "Mix",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "uint64 i;\nuint64 value;",
                        body: `
                            locals.i = input.seed;
                            locals.value = locals.i++ + 10;
                            state.mut().sum += locals.value;
                            locals.value = ++locals.i + 100;
                            state.mut().sum += locals.value;
                            locals.i = QPI::mod(input.seed, 8ULL);
                            state.mut().slots.set(locals.i++, locals.i);
                            state.mut().indexAfter = locals.i;
                            state.mut().counter++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 sum;\nuint64 counter;\nuint64 slotZero;\nuint64 indexAfter;",
                        body: `
                            output.sum = state.get().sum;
                            output.counter = state.get().counter;
                            output.slotZero = state.get().slots.get(0);
                            output.indexAfter = state.get().indexAfter;
                        `,
                    },
                ],
                initialize: "state.mut().sum = 0;\nstate.mut().counter = 0;\nstate.mut().slots.setAll(0);\nstate.mut().indexAfter = 0;",
            });
            return { source, script: script(ladder([0n, 1n, 7n, 8n, 18446744073709551615n])) };
        },
    },

    {
        name: "IfLadderDenseVersusSparse",
        family: "controlflow",
        solidity: `${SOL}/various/switch_statement.sol`,
        stresses:
            "a dense if-ladder next to a sparse one over the same input — dense arms invite a jump table, sparse arms a comparison chain, and both must produce the same state",
        caveat: "Solidity has no switch; the original is an if-ladder too, which is why both spellings live in one contract.",
        axes: ["placement"],
        build(axis) {
            const dense = Array.from(
                { length: 8 },
                (_, index) => `${index === 0 ? "if" : "else if"} (input.selector == ${index})\n{\n    state.mut().denseHits += ${index + 1};\n}`,
            ).join("\n");
            const sparse = [1, 17, 4096, 65537, 1048576]
                .map((value, index) => `${index === 0 ? "if" : "else if"} (input.selector == ${value}ULL)\n{\n    state.mut().sparseHits += ${index + 1};\n}`)
                .join("\n");
            const source = emitContract({
                axis,
                name: "IfLadderDenseVersusSparse",
                header: {
                    archetype: "IfLadderDenseVersusSparse",
                    family: "controlflow",
                    solidity: `${SOL}/various/switch_statement.sol`,
                    stresses: "a dense arm ladder and a sparse one over one input",
                    caveat: "Solidity has no switch statement; both spellings are if-ladders",
                    axis: "dense vs sparse dispatch",
                },
                state: "uint64 denseHits;\nuint64 sparseHits;\nuint64 misses;\nuint64 calls;",
                entries: [
                    {
                        name: "Dispatch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 selector;",
                        locals: "uint64 before;",
                        body: `
                            locals.before = state.get().denseHits + state.get().sparseHits;
                            ${dense}
                            ${sparse}
                            if (locals.before == state.get().denseHits + state.get().sparseHits)
                            {
                                state.mut().misses++;
                            }
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 denseHits;\nuint64 sparseHits;\nuint64 misses;\nuint64 calls;",
                        body: `
                            output.denseHits = state.get().denseHits;
                            output.sparseHits = state.get().sparseHits;
                            output.misses = state.get().misses;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().denseHits = 0;\nstate.mut().sparseHits = 0;\nstate.mut().misses = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(ladder([0n, 3n, 7n, 8n, 17n, 65537n, 999n])) };
        },
    },
];
