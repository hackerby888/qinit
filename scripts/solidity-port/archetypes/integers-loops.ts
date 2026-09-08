// Accumulation: the arithmetic a loop does to a number, and the boundaries it crosses on the way.
//
// Ported from Solidity's `arithmetics/*` and `controlFlow/loops.sol`. Every archetype recomputes its
// result from scratch on each call, so the expected values depend only on the operands and can be
// derived by hand; the point of the loop is that the same total is reached by a different number of
// steps depending on the operands, which is where a wrongly folded trip count shows up.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

const SOL = "test/libsolidity/semanticTests";

export const INTEGER_LOOP_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "SumToBoundWithOverflow",
            family: "integers",
            solidity: `${SOL}/arithmetics/sum_loop.sol`,
            stresses: "a running sum against the closed form n(n+1)/2 — they agree until the sum wraps, and the first disagreement is where the wrap happened",
        },
        () => ({
            state: "uint64 looped;\nuint64 closedForm;\nuint64 agree;\nuint64 iterations;",
            locals: "uint64 i;\nuint64 bounded;\nuint64 running;",
            body: `
                locals.bounded = input.a > 1024 ? 1024 : input.a;
                locals.running = 0;
                for (locals.i = 1; locals.i <= locals.bounded; locals.i++)
                {
                    locals.running += locals.i;
                }
                state.mut().looped = locals.running;
                state.mut().closedForm = QPI::div(locals.bounded * (locals.bounded + 1), 2ULL);
                state.mut().agree = state.get().looped == state.get().closedForm ? 1 : 0;
                state.mut().iterations = locals.bounded;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [10n, 0n],
                [100n, 0n],
                [1024n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 1n, 0n], note: "an empty sum" },
                { pair: 1, values: [1n, 1n, 1n, 1n], note: "one term" },
                { pair: 2, values: [55n, 55n, 1n, 10n], note: "the first ten" },
                { pair: 3, values: [5050n, 5050n, 1n, 100n], note: "the first hundred" },
                { pair: 4, values: [524800n, 524800n, 1n, 1024n], note: "the clamp point" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ProductUntilOverflow",
            family: "integers",
            solidity: `${SOL}/arithmetics/factorial.sol`,
            stresses:
                "a factorial that runs until the product wraps, with the last exact step recorded — 20! is the largest that fits in 64 bits, so the boundary is reachable in one call",
        },
        () => ({
            state: "uint64 product;\nuint64 lastExactStep;\nuint64 wrapped;\nuint64 steps;",
            locals: "uint64 i;\nuint64 bounded;\nuint64 running;\nuint64 previous;",
            body: `
                locals.bounded = input.a > 25 ? 25 : input.a;
                locals.running = 1;
                for (locals.i = 1; locals.i <= locals.bounded; locals.i++)
                {
                    locals.previous = locals.running;
                    locals.running = locals.running * locals.i;
                    if (locals.i != 0 && QPI::div(locals.running, locals.i) == locals.previous)
                    {
                        state.mut().lastExactStep = locals.i;
                    }
                    else
                    {
                        state.mut().wrapped = 1;
                    }
                }
                state.mut().product = locals.running;
                state.mut().steps = locals.bounded;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [5n, 0n],
                [20n, 0n],
                [21n, 0n],
                [25n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 0n, 0n, 0n], note: "the empty product is one" },
                { pair: 2, values: [120n, 5n, 0n, 5n], note: "5! = 120" },
                { pair: 3, values: [2432902008176640000n, 20n, 0n, 20n], note: "20! is the largest exact factorial at 64 bits" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "FibonacciIterativeWrap",
            family: "integers",
            solidity: `${SOL}/arithmetics/fibonacci.sol`,
            stresses:
                "an iterative Fibonacci to a caller-chosen index, where the 94th term is the last that fits — a two-variable rotation the compiler may reorder",
        },
        () => ({
            state: "uint64 value;\nuint64 previous;\nuint64 index;\nuint64 wrapped;",
            locals: "uint64 i;\nuint64 bounded;\nuint64 a;\nuint64 b;\nuint64 next;",
            body: `
                locals.bounded = input.a > 100 ? 100 : input.a;
                locals.a = 0;
                locals.b = 1;
                for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                {
                    locals.next = locals.a + locals.b;
                    if (locals.next < locals.b)
                    {
                        state.mut().wrapped = 1;
                    }
                    locals.a = locals.b;
                    locals.b = locals.next;
                }
                state.mut().value = locals.a;
                state.mut().previous = locals.b;
                state.mut().index = locals.bounded;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [10n, 0n],
                [50n, 0n],
                [93n, 0n],
                [100n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 1n, 0n, 0n], note: "F(0) = 0" },
                { pair: 1, values: [1n, 1n, 1n, 0n], note: "F(1) = 1" },
                { pair: 2, values: [55n, 89n, 10n, 0n], note: "F(10) = 55" },
                { pair: 3, values: [12586269025n, 20365011074n, 50n, 0n], note: "F(50)" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "CollatzStepCount",
            family: "integers",
            solidity: "no Solidity analogue (Collatz)",
            stresses:
                "the Collatz sequence with a step cap — a data-dependent loop whose trip count no compiler can fold, and whose peak value is where the multiply can wrap",
        },
        () => ({
            state: "uint64 steps;\nuint64 peak;\nuint64 reachedOne;\nuint64 capped;",
            locals: "uint64 value;\nuint64 count;",
            body: `
                locals.value = input.a == 0 ? 1 : input.a;
                locals.count = 0;
                state.mut().peak = locals.value;
                while (locals.value != 1 && locals.count < 200)
                {
                    if (QPI::mod(locals.value, 2ULL) == 0)
                    {
                        locals.value = QPI::div(locals.value, 2ULL);
                    }
                    else
                    {
                        locals.value = locals.value * 3 + 1;
                    }
                    if (locals.value > state.get().peak)
                    {
                        state.mut().peak = locals.value;
                    }
                    locals.count++;
                }
                state.mut().steps = locals.count;
                state.mut().reachedOne = locals.value == 1 ? 1 : 0;
                state.mut().capped = locals.count == 200 ? 1 : 0;
            `,
            pairs: [
                [1n, 0n],
                [2n, 0n],
                [6n, 0n],
                [27n, 0n],
                [0n, 0n],
                [97n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 1n, 1n, 0n], note: "one is already there" },
                { pair: 1, values: [1n, 2n, 1n, 0n], note: "two halves once" },
                { pair: 2, values: [8n, 16n, 1n, 0n], note: "six takes eight steps and peaks at sixteen" },
                { pair: 3, values: [111n, 9232n, 1n, 0n], note: "27 is the classic long one" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DigitReversalRoundTrip",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/Strings.sol",
            stresses:
                "reversing a number's decimal digits and reversing again — the round trip only returns the original when it has no trailing zeros, which is the case the archetype counts",
        },
        () => ({
            state: "uint64 reversed;\nuint64 doubleReversed;\nuint64 roundTrips;\nuint64 digits;",
            locals: "uint64 value;\nuint64 out;\nuint64 count;\nuint64 i;",
            body: `
                locals.value = input.a;
                locals.out = 0;
                locals.count = 0;
                while (locals.value != 0 && locals.count < 20)
                {
                    locals.out = locals.out * 10 + QPI::mod(locals.value, 10ULL);
                    locals.value = QPI::div(locals.value, 10ULL);
                    locals.count++;
                }
                state.mut().reversed = locals.out;
                state.mut().digits = locals.count;
                locals.value = locals.out;
                locals.out = 0;
                for (locals.i = 0; locals.i < locals.count; locals.i++)
                {
                    locals.out = locals.out * 10 + QPI::mod(locals.value, 10ULL);
                    locals.value = QPI::div(locals.value, 10ULL);
                }
                state.mut().doubleReversed = locals.out;
                state.mut().roundTrips = locals.out == input.a ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [12345n, 0n],
                [1200n, 0n],
                [7n, 0n],
                [1000000007n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 1n, 0n], note: "zero has no digits and reverses to itself" },
                { pair: 1, values: [54321n, 12345n, 1n, 5n], note: "a clean round trip" },
                {
                    pair: 2,
                    values: [21n, 1200n, 1n, 4n],
                    note: "1200 reverses to 21, and reversing back over the same digit count restores the trailing zeros",
                },
                { pair: 3, values: [7n, 7n, 1n, 1n], note: "one digit" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "BitCountingLoopVersusFormula",
            family: "integers",
            solidity: "solady/LibBit.sol",
            stresses:
                "counting the set bits by shifting, and the highest set bit by the same loop — two answers from one pass, checked against a shift-based reconstruction",
        },
        () => ({
            state: "uint64 setBits;\nuint64 highestBit;\nuint64 reconstructed;\nuint64 exact;",
            locals: "uint64 value;\nuint64 i;\nuint64 count;\nuint64 highest;",
            body: `
                locals.value = input.a;
                locals.count = 0;
                locals.highest = 0;
                for (locals.i = 0; locals.i < 64; locals.i++)
                {
                    if (((locals.value >> locals.i) & 1ULL) != 0)
                    {
                        locals.count++;
                        locals.highest = locals.i;
                    }
                }
                state.mut().setBits = locals.count;
                state.mut().highestBit = locals.highest;
                state.mut().reconstructed = locals.count == 0 ? 0 : (1ULL << locals.highest);
                state.mut().exact = state.get().reconstructed == input.a ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [255n, 0n],
                [9223372036854775808n, 0n],
                [18446744073709551615n, 0n],
                [1024n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 1n], note: "zero has no bits and reconstructs to zero" },
                { pair: 1, values: [1n, 0n, 1n, 1n], note: "bit zero" },
                { pair: 2, values: [8n, 7n, 128n, 0n], note: "eight bits, highest is seven" },
                { pair: 3, values: [1n, 63n, 9223372036854775808n, 1n], note: "the top bit alone" },
                { pair: 4, values: [64n, 63n, 9223372036854775808n, 0n], note: "all bits set" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ModularExponentiation",
            family: "integers",
            solidity: `${SOL}/arithmetics/exp_modulo.sol`,
            stresses:
                "modular exponentiation by squaring against repeated multiplication — the two agree only if every intermediate reduction happens at the same point",
        },
        () => ({
            state: "uint64 bySquaring;\nuint64 byRepetition;\nuint64 agree;\nuint64 modulus;",
            locals: "uint64 base;\nuint64 exponent;\nuint64 modulus;\nuint64 result;\nuint64 factor;\nuint64 i;",
            body: `
                locals.modulus = QPI::mod(input.b, 1000ULL) + 2;
                locals.base = QPI::mod(input.a, locals.modulus);
                locals.exponent = QPI::mod(input.a, 16ULL);
                state.mut().modulus = locals.modulus;

                locals.result = 1;
                locals.factor = locals.base;
                locals.i = locals.exponent;
                while (locals.i != 0)
                {
                    if ((locals.i & 1ULL) != 0)
                    {
                        locals.result = QPI::mod(locals.result * locals.factor, locals.modulus);
                    }
                    locals.factor = QPI::mod(locals.factor * locals.factor, locals.modulus);
                    locals.i = locals.i >> 1;
                }
                state.mut().bySquaring = locals.result;

                locals.result = 1;
                for (locals.i = 0; locals.i < locals.exponent; locals.i++)
                {
                    locals.result = QPI::mod(locals.result * locals.base, locals.modulus);
                }
                state.mut().byRepetition = locals.result;
                state.mut().agree = state.get().bySquaring == state.get().byRepetition ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [3n, 5n],
                [7n, 13n],
                [15n, 997n],
                [18446744073709551615n, 1n],
                [1000n, 100n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "AccumulateWithSaturation",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/Math.sol (tryAdd in a loop)",
            stresses:
                "a loop that adds until it would overflow and then saturates — the check has to happen before the addition, and the iteration where it fired is recorded",
        },
        () => ({
            state: "uint64 total;\nuint64 saturatedAt;\nuint64 saturated;\nuint64 iterations;",
            locals: "uint64 i;\nuint64 step;\nuint64 running;",
            body: `
                locals.step = input.a;
                locals.running = 0;
                state.mut().saturated = 0;
                state.mut().saturatedAt = 0;
                for (locals.i = 0; locals.i < 16; locals.i++)
                {
                    if (locals.running > 18446744073709551615ULL - locals.step)
                    {
                        if (state.get().saturated == 0)
                        {
                            state.mut().saturated = 1;
                            state.mut().saturatedAt = locals.i;
                        }
                        locals.running = 18446744073709551615ULL;
                    }
                    else
                    {
                        locals.running += locals.step;
                    }
                }
                state.mut().total = locals.running;
                state.mut().iterations = 16;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [1152921504606846976n, 0n],
                [2305843009213693952n, 0n],
                [18446744073709551615n, 0n],
                [1000n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 16n], note: "adding zero never saturates" },
                { pair: 1, values: [16n, 0n, 0n, 16n], note: "sixteen ones" },
                {
                    pair: 2,
                    values: [18446744073709551615n, 15n, 1n, 16n],
                    note: "2^60 added sixteen times reaches 2^64, so the guard fires on the sixteenth step",
                },
                { pair: 4, values: [18446744073709551615n, 1n, 1n, 16n], note: "the maximum saturates on the second step" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "NestedLoopMatrixTrace",
            family: "integers",
            solidity: `${SOL}/controlFlow/loops.sol`,
            stresses:
                "a triple-nested loop computing a trace and a checksum over a computed matrix — 4^3 iterations of index arithmetic with no container involved",
        },
        () => ({
            state: "uint64 trace;\nuint64 checksum;\nuint64 iterations;\nuint64 diagonalHits;",
            locals: "uint64 i;\nuint64 j;\nuint64 k;\nuint64 cell;",
            body: `
                state.mut().trace = 0;
                state.mut().checksum = 0;
                state.mut().iterations = 0;
                state.mut().diagonalHits = 0;
                for (locals.i = 0; locals.i < 4; locals.i++)
                {
                    for (locals.j = 0; locals.j < 4; locals.j++)
                    {
                        for (locals.k = 0; locals.k < 4; locals.k++)
                        {
                            locals.cell = (locals.i + 1) * (locals.j + 2) * (locals.k + 3) + input.a;
                            state.mut().checksum += locals.cell;
                            state.mut().iterations++;
                            if (locals.i == locals.j && locals.j == locals.k)
                            {
                                state.mut().trace += locals.cell;
                                state.mut().diagonalHits++;
                            }
                        }
                    }
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [1000n, 0n],
            ],
            expect: [
                { pair: 0, values: [210n, 2520n, 64n, 4n], note: "the checksum factors as 10 * 14 * 18; the diagonal is 6 + 24 + 60 + 120" },
                { pair: 1, values: [214n, 2584n, 64n, 4n], note: "the offset adds one per cell, so 64 to the checksum and 4 to the trace" },
                { pair: 2, values: [4210n, 66520n, 64n, 4n], note: "and a thousand per cell" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "GcdLcmPair",
            family: "integers",
            solidity: "no Solidity analogue (number theory)",
            stresses:
                "gcd by subtraction and lcm through it, where the lcm's multiply overflows long before either input does — the guard is a division before the multiply",
        },
        () => ({
            state: "uint64 gcd;\nuint64 lcm;\nuint64 overflowed;\nuint64 steps;",
            locals: "uint64 a;\nuint64 b;\nuint64 t;\nuint64 count;",
            body: `
                locals.a = input.a;
                locals.b = input.b;
                locals.count = 0;
                while (locals.b != 0 && locals.count < 128)
                {
                    locals.t = QPI::mod(locals.a, locals.b);
                    locals.a = locals.b;
                    locals.b = locals.t;
                    locals.count++;
                }
                state.mut().gcd = locals.a;
                state.mut().steps = locals.count;
                if (locals.a == 0)
                {
                    state.mut().lcm = 0;
                }
                else
                {
                    locals.t = QPI::div(input.a, locals.a);
                    state.mut().lcm = locals.t * input.b;
                    if (input.b != 0 && QPI::div(state.get().lcm, input.b) != locals.t)
                    {
                        state.mut().overflowed = 1;
                    }
                }
            `,
            pairs: [
                [0n, 0n],
                [12n, 18n],
                [7n, 13n],
                [1000000n, 999999n],
                [18446744073709551615n, 2n],
                [8n, 8n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 0n], note: "gcd(0, 0) is zero and the lcm with it" },
                { pair: 1, values: [6n, 36n, 0n, 3n], note: "gcd 6, lcm 36, in three Euclid steps" },
                { pair: 2, values: [1n, 91n, 0n, 4n], note: "coprime, so the lcm is the product; four steps to get there" },
                { pair: 5, values: [8n, 8n, 1n, 1n], note: "equal operands; the overflow flag is still set by the maximum-operand pair before it" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "AlternatingSeriesSigned",
            family: "integers",
            solidity: `${SOL}/arithmetics/signed_accumulation.sol`,
            stresses:
                "an alternating signed series whose partial sums cross zero repeatedly — the sign flips are counted, and the total must land where the closed form says",
        },
        () => ({
            state: "sint64 total;\nuint64 crossings;\nsint64 maximum;\nsint64 minimum;",
            locals: "uint64 i;\nuint64 bounded;\nsint64 running;\nsint64 term;",
            body: `
                locals.bounded = input.a > 32 ? 32 : input.a;
                locals.running = 0;
                state.mut().crossings = 0;
                state.mut().maximum = 0;
                state.mut().minimum = 0;
                for (locals.i = 1; locals.i <= locals.bounded; locals.i++)
                {
                    locals.term = QPI::mod(locals.i, 2ULL) == 1 ? (sint64)locals.i : (0 - (sint64)locals.i);
                    if ((locals.running < 0) != (locals.running + locals.term < 0))
                    {
                        state.mut().crossings++;
                    }
                    locals.running += locals.term;
                    if (locals.running > state.get().maximum)
                    {
                        state.mut().maximum = locals.running;
                    }
                    if (locals.running < state.get().minimum)
                    {
                        state.mut().minimum = locals.running;
                    }
                }
                state.mut().total = locals.running;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [2n, 0n],
                [10n, 0n],
                [11n, 0n],
                [32n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 0n], note: "no terms" },
                { pair: 1, values: [1n, 0n, 1n, 0n], note: "just +1" },
                { pair: 2, values: [-1n, 1n, 1n, -1n], note: "+1 -2 crosses zero once" },
                { pair: 3, values: [-5n, 9n, 5n, -5n], note: "ten terms end at -5, crossing zero after every one of the first nine" },
                { pair: 4, values: [6n, 10n, 6n, -5n], note: "eleven terms end at +6" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "PowerOfTwoRoundingBothWays",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/Math.sol (ceilDiv)",
            stresses:
                "rounding a value up and down to a power of two, by masking and by a shift loop — four answers that must agree pairwise on every input including zero and the maximum",
        },
        () => ({
            state: "uint64 roundedDown;\nuint64 roundedUp;\nuint64 byLoop;\nuint64 agree;",
            locals: "uint64 value;\nuint64 shift;\nuint64 candidate;",
            body: `
                locals.value = input.a;
                locals.shift = QPI::mod(input.b, 6ULL) + 1;
                locals.candidate = 1ULL << locals.shift;
                state.mut().roundedDown = locals.value & ~(locals.candidate - 1);
                if (locals.value > 18446744073709551615ULL - (locals.candidate - 1))
                {
                    state.mut().roundedUp = state.get().roundedDown;
                }
                else
                {
                    state.mut().roundedUp = (locals.value + locals.candidate - 1) & ~(locals.candidate - 1);
                }
                state.mut().byLoop = QPI::div(locals.value, locals.candidate) * locals.candidate;
                state.mut().agree = state.get().roundedDown == state.get().byLoop ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [7n, 1n],
                [8n, 2n],
                [255n, 5n],
                [18446744073709551615n, 5n],
                [1024n, 3n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 1n], note: "zero rounds to zero either way" },
                { pair: 1, values: [4n, 8n, 4n, 1n], note: "7 down to 4 and up to 8 at a stride of four" },
                { pair: 2, values: [8n, 8n, 8n, 1n], note: "already aligned" },
                { pair: 3, values: [192n, 256n, 192n, 1n], note: "255 at a stride of 64" },
            ],
        }),
    ),
];
