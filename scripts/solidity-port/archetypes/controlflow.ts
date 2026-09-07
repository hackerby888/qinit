// Control flow, guards and the revert port.
//
// Ported from Solidity's `statements`, `expressions`, `functionCall`, `modifiers` and `reverts` tests.
// The interesting one is the `require` family: QPI has no revert, so a failed guard does *not* roll back
// earlier writes. Two archetypes make that explicit — one guards before writing (the correct port) and
// one guards after (the honest port of a Solidity contract that relied on atomicity). Both must produce
// the same state on both backends; the point is that the states differ from each other.

import { emitContract } from "../emit";
import { loopHeader, widthOf } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

function driveTwo(pairs: [bigint, bigint][]): CallStep[] {
    const steps: CallStep[] = [];
    for (const [a, b] of pairs) {
        steps.push({ kind: "procedure", entry: 1, in: u64(a) + u64(b), invocator: 0, note: `${a}, ${b}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const CONTROLFLOW_ARCHETYPES: Archetype[] = [
    {
        name: "GuardBeforeWrite",
        family: "controlflow",
        solidity: `${SOL}/reverts/require_and_assert.sol`,
        stresses: "the correct `require` port: every guard runs before any state write, so a rejected call leaves state untouched",
        caveat: "Solidity's require reverts the whole transaction. QPI has no rollback, so correctness here depends on ordering.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                name: "GuardBeforeWrite",
                header: {
                    archetype: "GuardBeforeWrite",
                    family: "controlflow",
                    solidity: `${SOL}/reverts/require_and_assert.sol`,
                    stresses: "guard-then-write ordering",
                    caveat: "no rollback in QPI; the guard has to precede the writes",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 balance;\nuint64 writes;\nuint64 rejections;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Withdraw",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 unused;",
                        output: "uint64 ok;",
                        locals: "uint64 scratch;",
                        body: `
                            if (input.amount > state.get().balance)
                            {
                                state.mut().rejections++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().balance -= input.amount;
                            state.mut().writes++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 balance;\nuint64 writes;\nuint64 rejections;",
                        body: `
                            output.balance = state.get().balance;
                            output.writes = state.get().writes;
                            output.rejections = state.get().rejections;
                        `,
                    },
                ],
                initialize: "state.mut().balance = 1000;\nstate.mut().writes = 0;\nstate.mut().rejections = 0;",
            });
            return {
                source,
                script: script(
                    driveTwo([
                        [100n, 0n],
                        [2000n, 0n],
                        [900n, 0n],
                        [1n, 0n],
                    ]),
                ),
            };
        },
    },

    {
        name: "GuardAfterPartialWrite",
        family: "controlflow",
        solidity: `${SOL}/reverts/revert_after_state_change.sol`,
        stresses: "the honest port of a Solidity contract that relied on revert atomicity: the earlier write survives the failed guard",
        caveat: "In Solidity the whole call reverts and the first write is undone. In QPI it is not — this archetype documents that difference, and both backends must agree on the surviving state.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                name: "GuardAfterPartialWrite",
                header: {
                    archetype: "GuardAfterPartialWrite",
                    family: "controlflow",
                    solidity: `${SOL}/reverts/revert_after_state_change.sol`,
                    stresses: "a state write that survives a later guard failure",
                    caveat: "Solidity would revert the earlier write; QPI keeps it. The port asserts the surviving state.",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 balance;\nuint64 attempts;\nuint64 completed;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Withdraw",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 unused;",
                        output: "uint64 ok;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().attempts++;
                            if (input.amount > state.get().balance)
                            {
                                output.ok = 0;
                                return;
                            }
                            state.mut().balance -= input.amount;
                            state.mut().completed++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 balance;\nuint64 attempts;\nuint64 completed;",
                        body: `
                            output.balance = state.get().balance;
                            output.attempts = state.get().attempts;
                            output.completed = state.get().completed;
                        `,
                    },
                ],
                initialize: "state.mut().balance = 1000;\nstate.mut().attempts = 0;\nstate.mut().completed = 0;",
            });
            return {
                source,
                script: script(
                    driveTwo([
                        [100n, 0n],
                        [5000n, 0n],
                        [900n, 0n],
                    ]),
                ),
            };
        },
    },

    {
        name: "ShortCircuitSideEffect",
        family: "controlflow",
        solidity: `${SOL}/expressions/short_circuit.sol`,
        stresses: "&& and || must not evaluate the right operand when the left decides — a side effect that runs anyway is visible in state",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                name: "ShortCircuitSideEffect",
                header: {
                    archetype: "ShortCircuitSideEffect",
                    family: "controlflow",
                    solidity: `${SOL}/expressions/short_circuit.sol`,
                    stresses: "short-circuit evaluation order",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 sideEffects;\nuint64 andResult;\nuint64 orResult;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Evaluate",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 left;\nuint64 right;",
                        locals: "uint64 before;\nuint64 flag;",
                        body: `
                            locals.before = state.get().sideEffects;
                            // The right operand bumps the counter, so an evaluated-anyway operand shows up.
                            locals.flag = 0;
                            if ((input.left != 0) && (state.mut().sideEffects++ < 1000))
                            {
                                locals.flag = 1;
                            }
                            state.mut().andResult = locals.flag;
                            locals.flag = 0;
                            if ((input.right != 0) || (state.mut().sideEffects++ < 1000))
                            {
                                locals.flag = 1;
                            }
                            state.mut().orResult = locals.flag;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 sideEffects;\nuint64 andResult;\nuint64 orResult;",
                        body: `
                            output.sideEffects = state.get().sideEffects;
                            output.andResult = state.get().andResult;
                            output.orResult = state.get().orResult;
                        `,
                    },
                ],
                initialize: "state.mut().sideEffects = 0;\nstate.mut().andResult = 0;\nstate.mut().orResult = 0;",
            });
            return {
                source,
                script: script(
                    driveTwo([
                        [0n, 0n],
                        [1n, 0n],
                        [0n, 1n],
                        [1n, 1n],
                    ]),
                ),
            };
        },
    },

    {
        name: "LoopShapes",
        family: "controlflow",
        solidity: `${SOL}/statements/for_loop_continue.sol`,
        stresses: "a constant bound, an input-clamped bound the compiler cannot fold, and a zero-trip loop — with break and continue inside",
        axes: ["loopShape", "width"],
        build(axis) {
            const width = widthOf(axis, "uint64");
            const header = loopHeader(axis, "locals.i", "locals.bound", 8);
            const source = emitContract({
                name: "LoopShapes",
                header: {
                    archetype: "LoopShapes",
                    family: "controlflow",
                    solidity: `${SOL}/statements/for_loop_continue.sol`,
                    stresses: "loop bound shape crossed with accumulator width",
                    axis: `loopShape=${axis.loopShape ?? "constant"} width=${width}`,
                },
                state: `${width} total;\nuint64 iterations;\nuint64 skipped;`,
                entries: [
                    {
                        name: "Sum",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 bound;\nuint64 skipEvery;",
                        locals: "uint64 i;\nuint64 bound;\nuint64 count;\nuint64 skips;",
                        body: `
                            // Clamp the bound so the loop is statically bounded whatever the caller sends.
                            locals.bound = input.bound;
                            if (locals.bound > 64)
                            {
                                locals.bound = 64;
                            }
                            locals.count = 0;
                            locals.skips = 0;
                            ${header}
                            {
                                if (input.skipEvery != 0 && QPI::mod(locals.i, input.skipEvery) == 0)
                                {
                                    locals.skips++;
                                    continue;
                                }
                                if (locals.i > 60)
                                {
                                    break;
                                }
                                state.mut().total += (${width})locals.i;
                                locals.count++;
                            }
                            state.mut().iterations = locals.count;
                            state.mut().skipped = locals.skips;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${width} total;\nuint64 iterations;\nuint64 skipped;`,
                        body: `
                            output.total = state.get().total;
                            output.iterations = state.get().iterations;
                            output.skipped = state.get().skipped;
                        `,
                    },
                ],
                initialize: "state.mut().total = 0;\nstate.mut().iterations = 0;\nstate.mut().skipped = 0;",
            });
            return {
                source,
                script: script(
                    driveTwo([
                        [0n, 0n],
                        [8n, 0n],
                        [64n, 3n],
                        [1000n, 2n],
                    ]),
                ),
            };
        },
    },

    {
        name: "SwitchFallthrough",
        family: "controlflow",
        solidity: `${SOL}/statements/switch_emulation.sol`,
        stresses: "switch with deliberate fall-through, a default-only arm, and a value matching no case",
        caveat: "Solidity has no switch; the original is an if/else ladder, and the port keeps both spellings side by side so they can be compared.",
        axes: [],
        build() {
            const source = emitContract({
                name: "SwitchFallthrough",
                header: {
                    archetype: "SwitchFallthrough",
                    family: "controlflow",
                    solidity: `${SOL}/statements/switch_emulation.sol`,
                    stresses: "switch fall-through against the equivalent if/else ladder",
                    axis: "base",
                },
                state: "uint64 viaSwitch;\nuint64 viaLadder;\nuint64 agree;",
                entries: [
                    {
                        name: "Classify",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;\nuint64 unused;",
                        locals: "uint64 s;\nuint64 l;",
                        body: `
                            locals.s = 0;
                            switch (input.value)
                            {
                                case 0:
                                    locals.s += 1;
                                case 1:
                                    locals.s += 10;
                                    break;
                                case 2:
                                    locals.s += 100;
                                    break;
                                default:
                                    locals.s += 1000;
                                    break;
                            }
                            locals.l = 0;
                            if (input.value == 0)
                            {
                                locals.l += 11;
                            }
                            else if (input.value == 1)
                            {
                                locals.l += 10;
                            }
                            else if (input.value == 2)
                            {
                                locals.l += 100;
                            }
                            else
                            {
                                locals.l += 1000;
                            }
                            state.mut().viaSwitch = locals.s;
                            state.mut().viaLadder = locals.l;
                            state.mut().agree = (locals.s == locals.l) ? 1 : 0;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 viaSwitch;\nuint64 viaLadder;\nuint64 agree;",
                        body: `
                            output.viaSwitch = state.get().viaSwitch;
                            output.viaLadder = state.get().viaLadder;
                            output.agree = state.get().agree;
                        `,
                    },
                ],
                initialize: "state.mut().viaSwitch = 0;\nstate.mut().viaLadder = 0;\nstate.mut().agree = 0;",
            });
            return {
                source,
                script: script(
                    driveTwo([
                        [0n, 0n],
                        [1n, 0n],
                        [2n, 0n],
                        [99n, 0n],
                    ]),
                ),
            };
        },
    },

    {
        name: "ModifierAsPrivateFunction",
        family: "controlflow",
        solidity: `${SOL}/modifiers/modifier_calls_function.sol`,
        stresses: "the `modifier` port: a shared guard reached through PRIVATE_FUNCTION + CALL rather than inlined",
        caveat: "Solidity modifiers wrap the body; QPI has no modifiers, so the guard becomes a private function the entry calls first.",
        axes: [],
        build() {
            const source = emitContract({
                name: "ModifierAsPrivateFunction",
                header: {
                    archetype: "ModifierAsPrivateFunction",
                    family: "controlflow",
                    solidity: `${SOL}/modifiers/modifier_calls_function.sol`,
                    stresses: "a guard shared by two entries through a private function",
                    caveat: "modifier -> PRIVATE_FUNCTION + CALL",
                    axis: "base",
                },
                state: "uint64 owner;\nuint64 value;\nuint64 denied;",
                entries: [
                    {
                        name: "SetValue",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 caller;\nuint64 value;",
                        output: "uint64 ok;",
                        locals: "IsOwner_input checkInput;\nIsOwner_output checkOutput;",
                        body: `
                            locals.checkInput.caller = input.caller;
                            CALL(IsOwner, locals.checkInput, locals.checkOutput);
                            if (locals.checkOutput.allowed == 0)
                            {
                                state.mut().denied++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().value = input.value;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "IsOwner",
                        kind: "function",
                        number: 2,
                        input: "uint64 caller;",
                        output: "uint64 allowed;",
                        body: "output.allowed = (input.caller == state.get().owner) ? 1 : 0;",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 value;\nuint64 denied;",
                        body: "output.value = state.get().value;\noutput.denied = state.get().denied;",
                    },
                ],
                initialize: "state.mut().owner = 42;\nstate.mut().value = 0;\nstate.mut().denied = 0;",
            });
            return {
                source,
                script: script(
                    driveTwo([
                        [42n, 7n],
                        [1n, 9n],
                        [42n, 0n],
                    ]),
                ),
            };
        },
    },
];
