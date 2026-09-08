// Control-flow shapes as arithmetic: state machines, retry loops, dispatch ladders and the unrolling
// boundary. Ported from Solidity's `controlFlow/*` and `expressions/*`.
//
// Each of these reduces to "two numbers in, several numbers out", so they use the shared two-operand
// skeleton and spend their length on the branch structure rather than on plumbing. Where the answer
// follows from the control flow alone it carries a hand-derived `expect` row.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

const SOL = "test/libsolidity/semanticTests";

export const CONTROLFLOW_PATTERN_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "StateMachineTransitionTable",
            family: "controlflow",
            solidity: `${SOL}/various/state_machine.sol`,
            stresses:
                "a four-state machine driven by an event code, where illegal transitions are refused and counted — the branch tree every escrow and auction contract is built from",
        },
        () => ({
            state: "uint64 currentState;\nuint64 transitions;\nuint64 refused;\nuint64 terminalReached;",
            locals: "uint64 event;\nuint64 next;",
            body: `
                locals.event = QPI::mod(input.a, 4ULL);
                locals.next = state.get().currentState;
                if (state.get().currentState == 0 && locals.event == 1)
                {
                    locals.next = 1;
                }
                else if (state.get().currentState == 1 && locals.event == 2)
                {
                    locals.next = 2;
                }
                else if (state.get().currentState == 2 && locals.event == 3)
                {
                    locals.next = 3;
                }
                else if (state.get().currentState == 1 && locals.event == 3)
                {
                    locals.next = 0;
                }
                if (locals.next == state.get().currentState)
                {
                    state.mut().refused++;
                }
                else
                {
                    state.mut().transitions++;
                    state.mut().currentState = locals.next;
                    if (locals.next == 3)
                    {
                        state.mut().terminalReached++;
                    }
                }
            `,
            pairs: [
                [2n, 0n],
                [1n, 0n],
                [2n, 0n],
                [3n, 0n],
                [1n, 0n],
                [0n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "RetryLoopWithBackoff",
            family: "controlflow",
            solidity: `${SOL}/controlFlow/while_loop.sol`,
            stresses:
                "a retry loop whose delay doubles each attempt and whose budget is consumed by that delay — the loop stops for two different reasons, and which one fired is recorded",
        },
        () => ({
            state: "uint64 attempts;\nuint64 spent;\nuint64 exhaustedBudget;\nuint64 hitAttemptCap;",
            locals: "uint64 delay;\nuint64 budget;\nuint64 tries;",
            body: `
                locals.delay = 1;
                locals.budget = input.a;
                locals.tries = 0;
                while (locals.budget >= locals.delay && locals.tries < 8)
                {
                    locals.budget -= locals.delay;
                    locals.delay = locals.delay * 2;
                    locals.tries++;
                }
                state.mut().attempts = locals.tries;
                state.mut().spent = input.a - locals.budget;
                if (locals.tries == 8)
                {
                    state.mut().hitAttemptCap++;
                }
                else
                {
                    state.mut().exhaustedBudget++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [7n, 0n],
                [255n, 0n],
                [1000n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 1n, 0n], note: "no budget, no attempts" },
                { pair: 1, values: [1n, 1n, 2n, 0n], note: "one attempt costs one" },
                { pair: 2, values: [3n, 7n, 3n, 0n], note: "1 + 2 + 4 exhausts a budget of 7" },
                { pair: 3, values: [8n, 255n, 3n, 1n], note: "255 is exactly eight doublings, so the cap fires" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "NestedTernaryDispatch",
            family: "controlflow",
            solidity: `${SOL}/expressions/conditional_expression_type.sol`,
            stresses:
                "a four-way dispatch written as nested conditionals and again as an if-ladder, with both results stored so a mis-nested arm is a wrong number",
        },
        () => ({
            state: "uint64 viaTernary;\nuint64 viaLadder;\nuint64 disagreements;",
            locals: "uint64 value;",
            body: `
                locals.value = input.a;
                state.mut().viaTernary = locals.value < 10 ? 1 : (locals.value < 100 ? 2 : (locals.value < 1000 ? 3 : 4));
                if (locals.value < 10)
                {
                    state.mut().viaLadder = 1;
                }
                else if (locals.value < 100)
                {
                    state.mut().viaLadder = 2;
                }
                else if (locals.value < 1000)
                {
                    state.mut().viaLadder = 3;
                }
                else
                {
                    state.mut().viaLadder = 4;
                }
                if (state.get().viaTernary != state.get().viaLadder)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [0n, 0n],
                [9n, 0n],
                [10n, 0n],
                [999n, 0n],
                [1000n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 1n, 0n], note: "the first arm" },
                { pair: 2, values: [2n, 2n, 0n], note: "on the first boundary" },
                { pair: 4, values: [4n, 4n, 0n], note: "past the last boundary" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "UnrollBoundaryEightIterations",
            family: "controlflow",
            solidity: `${SOL}/controlFlow/loops.sol`,
            stresses:
                "a loop whose trip count is one, two, four, eight or nine — the sizes a compiler is most likely to unroll, with a running sum that must not depend on how it was compiled",
        },
        () => ({
            state: "uint64 sum;\nuint64 squares;\nuint64 iterations;\nuint64 lastIndex;",
            locals: "uint64 i;\nuint64 bounded;",
            body: `
                locals.bounded = input.a > 32 ? 32 : input.a;
                state.mut().sum = 0;
                state.mut().squares = 0;
                for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                {
                    state.mut().sum += locals.i + 1;
                    state.mut().squares += (locals.i + 1) * (locals.i + 1);
                    state.mut().lastIndex = locals.i;
                }
                state.mut().iterations = locals.bounded;
            `,
            pairs: [
                [1n, 0n],
                [2n, 0n],
                [4n, 0n],
                [8n, 0n],
                [9n, 0n],
                [0n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 1n, 1n, 0n], note: "one iteration" },
                { pair: 1, values: [3n, 5n, 2n, 1n], note: "1+2 and 1+4" },
                { pair: 2, values: [10n, 30n, 4n, 3n], note: "the first four" },
                { pair: 3, values: [36n, 204n, 8n, 7n], note: "the first eight" },
                { pair: 4, values: [45n, 285n, 9n, 8n], note: "one past the likely unroll width" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "BothArmsWriteDifferentMembers",
            family: "controlflow",
            solidity: `${SOL}/controlFlow/if_else.sol`,
            stresses:
                "a branch where each arm writes a different member and neither writes the other's — so a merged or hoisted store shows up as a member that moved when it should not have",
        },
        () => ({
            state: "uint64 evenPath;\nuint64 oddPath;\nuint64 shared;\nuint64 untouched;",
            locals: "uint64 value;",
            body: `
                locals.value = input.a;
                if (QPI::mod(locals.value, 2ULL) == 0)
                {
                    state.mut().evenPath = locals.value;
                    state.mut().shared = locals.value * 2;
                }
                else
                {
                    state.mut().oddPath = locals.value;
                    state.mut().shared = locals.value * 3;
                }
            `,
            pairs: [
                [2n, 0n],
                [3n, 0n],
                [4n, 0n],
                [0n, 0n],
                [18446744073709551615n, 0n],
                [10n, 0n],
            ],
            expect: [
                { pair: 0, values: [2n, 0n, 4n, 0n], note: "the even arm only" },
                { pair: 1, values: [2n, 3n, 9n, 0n], note: "the odd arm leaves the even member alone" },
                { pair: 3, values: [0n, 3n, 0n, 0n], note: "zero is even, and the even member is overwritten with it" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "WhileWithTwoExitConditions",
            family: "controlflow",
            solidity: `${SOL}/controlFlow/while_loop.sol`,
            stresses:
                "a loop with two exit conditions where which one fired is recorded — the classic place an `||` and an `&&` get swapped without changing most outcomes",
        },
        () => ({
            state: "uint64 iterations;\nuint64 remaining;\nuint64 exitByValue;\nuint64 exitByCounter;",
            locals: "uint64 value;\nuint64 counter;",
            body: `
                locals.value = input.a;
                locals.counter = 0;
                while (locals.value > input.b && locals.counter < 10)
                {
                    locals.value = QPI::div(locals.value, 2ULL);
                    locals.counter++;
                }
                state.mut().iterations = locals.counter;
                state.mut().remaining = locals.value;
                if (locals.counter == 10)
                {
                    state.mut().exitByCounter++;
                }
                else
                {
                    state.mut().exitByValue++;
                }
            `,
            pairs: [
                [0n, 0n],
                [8n, 1n],
                [1024n, 1n],
                [18446744073709551615n, 0n],
                [5n, 5n],
                [100n, 3n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 1n, 0n], note: "the condition is false at entry" },
                { pair: 1, values: [3n, 1n, 2n, 0n], note: "8 halves three times to reach 1" },
                { pair: 2, values: [10n, 1n, 2n, 1n], note: "1024 needs ten halvings, which is the counter cap" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DoWhileEmulatedWithFlag",
            family: "controlflow",
            solidity: `${SOL}/controlFlow/do_while_loop.sol`,
            stresses:
                "a do-while written as a flag plus a while, so the body runs once even when the condition is false at entry — next to the plain while that does not",
            caveat: "QPI accepts `while` but the port writes the do-while as a flag anyway, because that is the shape a contract author reaches for and it makes the once-through guarantee explicit.",
        },
        () => ({
            state: "uint64 doWhileRuns;\nuint64 whileRuns;\nuint64 difference;",
            locals: "uint64 value;\nuint64 first;",
            body: `
                locals.value = input.a;
                locals.first = 1;
                state.mut().doWhileRuns = 0;
                while (locals.first != 0 || locals.value > 10)
                {
                    locals.first = 0;
                    state.mut().doWhileRuns++;
                    if (locals.value > 0)
                    {
                        locals.value = QPI::div(locals.value, 3ULL);
                    }
                    if (state.get().doWhileRuns > 20)
                    {
                        locals.value = 0;
                    }
                }
                locals.value = input.a;
                state.mut().whileRuns = 0;
                while (locals.value > 10 && state.get().whileRuns < 20)
                {
                    locals.value = QPI::div(locals.value, 3ULL);
                    state.mut().whileRuns++;
                }
                state.mut().difference = state.get().doWhileRuns - state.get().whileRuns;
            `,
            pairs: [
                [0n, 0n],
                [5n, 0n],
                [11n, 0n],
                [100n, 0n],
                [1000n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 0n, 1n], note: "the do-while runs once, the while not at all" },
                { pair: 1, values: [1n, 0n, 1n], note: "below the threshold, same again" },
                { pair: 2, values: [1n, 1n, 0n], note: "11 halves below the threshold on the first pass, so the free pass and the division are the same pass" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "BreakOutOfThreeLevels",
            family: "controlflow",
            solidity: `${SOL}/controlFlow/return_and_break.sol`,
            stresses:
                "three nested loops with a break at the innermost and a flag carrying the exit outward — the pattern C++ needs because it has no labelled break",
        },
        () => ({
            state: "uint64 visited;\nuint64 foundAt;\nuint64 broke;\nuint64 completed;",
            locals: "uint64 i;\nuint64 j;\nuint64 k;\nuint64 done;\nuint64 target;",
            body: `
                locals.target = QPI::mod(input.a, 64ULL);
                locals.done = 0;
                state.mut().visited = 0;
                for (locals.i = 0; locals.i < 4 && locals.done == 0; locals.i++)
                {
                    for (locals.j = 0; locals.j < 4 && locals.done == 0; locals.j++)
                    {
                        for (locals.k = 0; locals.k < 4; locals.k++)
                        {
                            state.mut().visited++;
                            if (locals.i * 16 + locals.j * 4 + locals.k == locals.target)
                            {
                                state.mut().foundAt = locals.target;
                                locals.done = 1;
                                break;
                            }
                        }
                    }
                }
                if (locals.done != 0)
                {
                    state.mut().broke++;
                }
                else
                {
                    state.mut().completed++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [21n, 0n],
                [63n, 0n],
                [64n, 0n],
                [100n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 0n, 1n, 0n], note: "found on the first visit" },
                { pair: 1, values: [2n, 1n, 2n, 0n], note: "the second cell" },
                { pair: 3, values: [64n, 63n, 4n, 0n], note: "the last cell needs the whole walk; every pair so far has broken out" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "RangeLadderWithOverlap",
            family: "controlflow",
            solidity: `${SOL}/various/switch_statement.sol`,
            stresses:
                "a range ladder whose arms deliberately overlap, so only the order of the tests decides the answer — and a second ladder written in the opposite order for comparison",
        },
        () => ({
            state: "uint64 firstMatch;\nuint64 lastMatch;\nuint64 differ;",
            locals: "uint64 value;",
            body: `
                locals.value = input.a;
                if (locals.value < 1000)
                {
                    state.mut().firstMatch = 1;
                }
                else if (locals.value < 100)
                {
                    state.mut().firstMatch = 2;
                }
                else if (locals.value < 10)
                {
                    state.mut().firstMatch = 3;
                }
                else
                {
                    state.mut().firstMatch = 4;
                }
                if (locals.value < 10)
                {
                    state.mut().lastMatch = 3;
                }
                else if (locals.value < 100)
                {
                    state.mut().lastMatch = 2;
                }
                else if (locals.value < 1000)
                {
                    state.mut().lastMatch = 1;
                }
                else
                {
                    state.mut().lastMatch = 4;
                }
                if (state.get().firstMatch != state.get().lastMatch)
                {
                    state.mut().differ++;
                }
            `,
            pairs: [
                [5n, 0n],
                [50n, 0n],
                [500n, 0n],
                [5000n, 0n],
                [0n, 0n],
                [9n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 3n, 1n], note: "5 matches the widest arm first and the narrowest last" },
                { pair: 2, values: [1n, 1n, 2n], note: "500 only matches the widest arm either way" },
                { pair: 3, values: [4n, 4n, 2n], note: "5000 falls through both ladders" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ShortCircuitOrChainCounts",
            family: "controlflow",
            solidity: `${SOL}/expressions/short_circuit.sol`,
            stresses: "a three-term `||` where each term increments a counter as a side effect, so the counter says exactly how many terms were evaluated",
        },
        () => ({
            state: "uint64 evaluated;\nuint64 result;\nuint64 firstTrue;",
            locals: "uint64 value;\nuint64 flag;",
            body: `
                locals.value = input.a;
                state.mut().evaluated = 0;
                locals.flag = 0;
                state.mut().evaluated++;
                if (locals.value > 100)
                {
                    locals.flag = 1;
                    state.mut().firstTrue = 1;
                }
                if (locals.flag == 0)
                {
                    state.mut().evaluated++;
                    if (QPI::mod(locals.value, 7ULL) == 0)
                    {
                        locals.flag = 1;
                        state.mut().firstTrue = 2;
                    }
                }
                if (locals.flag == 0)
                {
                    state.mut().evaluated++;
                    if (locals.value == 13)
                    {
                        locals.flag = 1;
                        state.mut().firstTrue = 3;
                    }
                }
                state.mut().result = locals.flag;
            `,
            pairs: [
                [200n, 0n],
                [14n, 0n],
                [13n, 0n],
                [5n, 0n],
                [0n, 0n],
                [101n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 1n, 1n], note: "the first term settles it" },
                { pair: 1, values: [2n, 1n, 2n], note: "14 is divisible by seven" },
                { pair: 2, values: [3n, 1n, 3n], note: "13 needs all three terms" },
                { pair: 3, values: [3n, 0n, 3n], note: "5 matches nothing, so all three are evaluated" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ParityAndSignBranches",
            family: "controlflow",
            solidity: `${SOL}/controlFlow/if_else.sol`,
            stresses:
                "a four-way branch on the parity and the sign of one signed operand — two independent bits producing four paths, each writing a distinct value",
        },
        () => ({
            state: "uint64 quadrant;\nsint64 adjusted;\nuint64 negatives;\nuint64 evens;",
            locals: "sint64 value;\nuint64 isNegative;\nuint64 isEven;",
            body: `
                locals.value = (sint64)input.a;
                locals.isNegative = locals.value < 0 ? 1 : 0;
                locals.isEven = QPI::mod(locals.value, (sint64)2) == 0 ? 1 : 0;
                state.mut().quadrant = locals.isNegative * 2 + locals.isEven;
                if (locals.isNegative != 0)
                {
                    state.mut().negatives++;
                    state.mut().adjusted = locals.isEven != 0 ? QPI::div(locals.value, (sint64)2) : locals.value * 3 - 1;
                }
                else
                {
                    state.mut().adjusted = locals.isEven != 0 ? QPI::div(locals.value, (sint64)2) : locals.value * 3 + 1;
                }
                if (locals.isEven != 0)
                {
                    state.mut().evens++;
                }
            `,
            pairs: [
                [4n, 0n],
                [5n, 0n],
                [-4n, 0n],
                [-5n, 0n],
                [0n, 0n],
                [-9223372036854775808n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 2n, 0n, 1n], note: "positive and even" },
                { pair: 1, values: [0n, 16n, 0n, 1n], note: "positive and odd: 3n+1" },
                { pair: 2, values: [3n, -2n, 1n, 2n], note: "negative and even" },
                { pair: 3, values: [2n, -16n, 2n, 2n], note: "negative and odd: 3n-1" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "GuardedDivisionPaths",
            family: "controlflow",
            solidity: `${SOL}/expressions/division_by_zero.sol`,
            stresses: "three ways of not dividing by zero — a guard before, QPI::div's own guard, and a substituted divisor — with the three results compared",
        },
        () => ({
            state: "uint64 guarded;\nuint64 builtin;\nuint64 substituted;\nuint64 allAgree;\nuint64 zeroDivisors;",
            locals: "uint64 divisor;",
            body: `
                locals.divisor = input.b;
                if (locals.divisor == 0)
                {
                    state.mut().guarded = 0;
                    state.mut().zeroDivisors++;
                }
                else
                {
                    state.mut().guarded = QPI::div(input.a, locals.divisor);
                }
                state.mut().builtin = QPI::div(input.a, locals.divisor);
                state.mut().substituted = QPI::div(input.a, locals.divisor == 0 ? 1ULL : locals.divisor);
                state.mut().allAgree = state.get().guarded == state.get().builtin ? 1 : 0;
            `,
            pairs: [
                [100n, 7n],
                [100n, 0n],
                [0n, 0n],
                [18446744073709551615n, 1n],
                [1n, 18446744073709551615n],
                [255n, 16n],
            ],
            expect: [
                { pair: 0, values: [14n, 14n, 14n, 1n, 0n], note: "an ordinary division" },
                { pair: 1, values: [0n, 0n, 100n, 1n, 1n], note: "the substituted divisor gives the dividend back" },
                { pair: 3, values: [18446744073709551615n, 18446744073709551615n, 18446744073709551615n, 1n, 2n], note: "dividing by one" },
            ],
        }),
    ),
];
