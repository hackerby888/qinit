// Signed arithmetic at the boundaries, where C++ and Solidity part company and where this compiler has
// already produced one confirmed defect (F200).
//
// Ported from Solidity's `expressions/signed_*`, `arithmetics/*` and OpenZeppelin's `SignedMath`. Every
// archetype here overwrites its members on each call rather than accumulating, so the expected values
// depend only on the operands in front of them — that is what makes the hand-derived `expect` rows
// checkable at a glance, and those rows are the only thing in the corpus that can catch both backends
// being wrong in the same direction.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

const SOL = "test/libsolidity/semanticTests";
const OZ = "openzeppelin-contracts/contracts/utils/math/SignedMath.sol";

const SIGNED_PAIRS: [bigint, bigint][] = [
    [0n, 0n],
    [7n, 3n],
    [-7n, 3n],
    [7n, -3n],
    [-7n, -3n],
    [-9223372036854775808n, 1n],
];

export const INTEGER_SIGNED_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "SignedAbsoluteValue",
            family: "integers",
            solidity: `${OZ} (abs)`,
            stresses:
                "absolute value three ways — a branch, a ternary and the sign-mask trick — on operands including the minimum, where the true absolute value does not fit in the type",
        },
        () => ({
            state: "uint64 viaBranch;\nuint64 viaTernary;\nuint64 viaMask;\nuint64 allAgree;",
            locals: "sint64 value;\nsint64 mask;",
            body: `
                locals.value = (sint64)input.a;
                if (locals.value < 0)
                {
                    state.mut().viaBranch = (uint64)(0 - locals.value);
                }
                else
                {
                    state.mut().viaBranch = (uint64)locals.value;
                }
                state.mut().viaTernary = locals.value < 0 ? (uint64)(0 - locals.value) : (uint64)locals.value;
                locals.mask = locals.value >> 63;
                state.mut().viaMask = (uint64)((locals.value + locals.mask) ^ locals.mask);
                state.mut().allAgree = state.get().viaBranch == state.get().viaTernary && state.get().viaBranch == state.get().viaMask ? 1 : 0;
            `,
            pairs: SIGNED_PAIRS,
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 1n], note: "abs(0) = 0 by all three spellings" },
                { pair: 1, values: [7n, 7n, 7n, 1n], note: "abs(7)" },
                { pair: 2, values: [7n, 7n, 7n, 1n], note: "abs(-7)" },
                { pair: 5, values: [9223372036854775808n, 9223372036854775808n, 9223372036854775808n, 1n], note: "abs(INT64_MIN) wraps to 2^63 in all three" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedMinMaxAndAverage",
            family: "integers",
            solidity: `${OZ} (min, max, average)`,
            stresses:
                "signed min, max and the overflow-free average — the average is `(a & b) + ((a ^ b) >> 1)` for unsigned, and the signed version has to shift arithmetically",
        },
        () => ({
            state: "sint64 minimum;\nsint64 maximum;\nsint64 average;\nsint64 naiveAverage;",
            locals: "sint64 lhs;\nsint64 rhs;",
            body: `
                locals.lhs = (sint64)input.a;
                locals.rhs = (sint64)input.b;
                state.mut().minimum = locals.lhs < locals.rhs ? locals.lhs : locals.rhs;
                state.mut().maximum = locals.lhs > locals.rhs ? locals.lhs : locals.rhs;
                state.mut().average = (locals.lhs & locals.rhs) + ((locals.lhs ^ locals.rhs) >> 1);
                state.mut().naiveAverage = QPI::div(locals.lhs + locals.rhs, (sint64)2);
            `,
            pairs: [
                [0n, 0n],
                [10n, 20n],
                [-10n, -20n],
                [-10n, 20n],
                [9223372036854775807n, 9223372036854775807n],
                [-9223372036854775808n, 9223372036854775807n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 0n], note: "both zero" },
                { pair: 1, values: [10n, 20n, 15n, 15n], note: "the two averages agree in the ordinary case" },
                {
                    pair: 4,
                    values: [9223372036854775807n, 9223372036854775807n, 9223372036854775807n, -1n],
                    note: "the naive sum overflows; the bit trick does not",
                },
                { pair: 5, values: [-9223372036854775808n, 9223372036854775807n, -1n, 0n], note: "the extremes average to -1 by the bit trick, 0 by the sum" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedDivisionTruncatesTowardZero",
            family: "integers",
            solidity: `${SOL}/expressions/signed_division.sol`,
            stresses:
                "signed division and the floor-division that Solidity users usually mean, computed side by side so the difference on negative operands is explicit",
        },
        () => ({
            state: "sint64 truncated;\nsint64 floored;\nsint64 remainder;\nuint64 differs;",
            locals: "sint64 lhs;\nsint64 rhs;\nsint64 quotient;",
            body: `
                locals.lhs = (sint64)input.a;
                locals.rhs = (sint64)input.b;
                locals.quotient = QPI::div(locals.lhs, locals.rhs);
                state.mut().truncated = locals.quotient;
                state.mut().remainder = QPI::mod(locals.lhs, locals.rhs);
                if (state.get().remainder != 0 && ((locals.lhs < 0) != (locals.rhs < 0)))
                {
                    state.mut().floored = locals.quotient - 1;
                }
                else
                {
                    state.mut().floored = locals.quotient;
                }
                state.mut().differs = state.get().floored != state.get().truncated ? 1 : 0;
            `,
            pairs: SIGNED_PAIRS,
            expect: [
                { pair: 1, values: [2n, 2n, 1n, 0n], note: "7/3 = 2 remainder 1; both conventions agree" },
                { pair: 2, values: [-2n, -3n, -1n, 1n], note: "-7/3 truncates to -2 but floors to -3" },
                { pair: 3, values: [-2n, -3n, 1n, 1n], note: "7/-3 the same, with a positive remainder" },
                { pair: 4, values: [2n, 2n, -1n, 0n], note: "-7/-3 is positive, so the conventions agree" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedShiftRightIsArithmetic",
            family: "integers",
            solidity: `${SOL}/operators/shifts/shift_right_negative_lvalue.sol`,
            stresses:
                "arithmetic shift right on negative values, next to the logical shift of the same bits reinterpreted as unsigned — the pair that shows the sign bit being replicated",
        },
        () => ({
            state: "sint64 arithmetic;\nuint64 logical;\nsint64 dividedByPowerOfTwo;\nuint64 shiftMatchesDivision;",
            locals: "sint64 value;\nuint64 asUnsigned;",
            body: `
                locals.value = (sint64)input.a;
                locals.asUnsigned = input.a;
                state.mut().arithmetic = locals.value >> 2;
                state.mut().logical = locals.asUnsigned >> 2;
                state.mut().dividedByPowerOfTwo = QPI::div(locals.value, (sint64)4);
                state.mut().shiftMatchesDivision = state.get().arithmetic == state.get().dividedByPowerOfTwo ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [16n, 0n],
                [-16n, 0n],
                [-1n, 0n],
                [-7n, 0n],
                [9223372036854775807n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 1n], note: "zero shifts to zero" },
                { pair: 1, values: [4n, 4n, 4n, 1n], note: "16 >> 2 = 4 = 16/4" },
                { pair: 2, values: [-4n, 4611686018427387900n, -4n, 1n], note: "-16 >> 2 = -4, and as unsigned it is a huge number" },
                { pair: 3, values: [-1n, 4611686018427387903n, 0n, 0n], note: "-1 >> 2 stays -1 but -1/4 truncates to 0" },
                { pair: 4, values: [-2n, 4611686018427387902n, -1n, 0n], note: "-7 >> 2 floors to -2 while -7/4 truncates to -1" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedOverflowDetection",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/Math.sol (tryAdd, trySub)",
            stresses:
                "checked signed addition and subtraction written the way a library writes them — the guard is a comparison against the extremes, computed before the operation rather than after",
        },
        () => ({
            state: "sint64 sum;\nsint64 difference;\nuint64 addOverflows;\nuint64 subOverflows;",
            locals: "sint64 lhs;\nsint64 rhs;",
            body: `
                locals.lhs = (sint64)input.a;
                locals.rhs = (sint64)input.b;
                state.mut().addOverflows = 0;
                state.mut().subOverflows = 0;
                if (locals.rhs > 0 && locals.lhs > 9223372036854775807LL - locals.rhs)
                {
                    state.mut().addOverflows = 1;
                    state.mut().sum = 9223372036854775807LL;
                }
                else if (locals.rhs < 0 && locals.lhs < (0 - 9223372036854775807LL) - 1 - locals.rhs)
                {
                    state.mut().addOverflows = 1;
                    state.mut().sum = (0 - 9223372036854775807LL) - 1;
                }
                else
                {
                    state.mut().sum = locals.lhs + locals.rhs;
                }
                if (locals.rhs < 0 && locals.lhs > 9223372036854775807LL + locals.rhs)
                {
                    state.mut().subOverflows = 1;
                    state.mut().difference = 9223372036854775807LL;
                }
                else
                {
                    state.mut().difference = locals.lhs - locals.rhs;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 2n],
                [9223372036854775807n, 1n],
                [-9223372036854775808n, -1n],
                [9223372036854775807n, -1n],
                [-1n, -1n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 0n], note: "no overflow at zero" },
                { pair: 1, values: [3n, -1n, 0n, 0n], note: "ordinary values" },
                { pair: 2, values: [9223372036854775807n, 9223372036854775806n, 1n, 0n], note: "the add saturates at the maximum" },
                {
                    pair: 3,
                    values: [-9223372036854775808n, -9223372036854775807n, 1n, 0n],
                    note: "the addition saturates at the minimum; the subtraction lands one above it and needs no guard",
                },
                { pair: 5, values: [-2n, 0n, 0n, 0n], note: "-1 + -1 and -1 - -1" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignExtensionAcrossWidths",
            family: "integers",
            solidity: `${SOL}/cleanup/cleanup_bytes_types.sol`,
            stresses:
                "the same bit pattern read as sint8, sint16 and sint32 and widened to 64 bits — three sign extensions of one value, which must disagree exactly where the sign bit moves",
        },
        () => ({
            state: "sint64 fromByte;\nsint64 fromWord;\nsint64 fromDouble;\nuint64 allNegative;",
            locals: "sint8 asByte;\nsint16 asWord;\nsint32 asDouble;",
            body: `
                locals.asByte = (sint8)input.a;
                locals.asWord = (sint16)input.a;
                locals.asDouble = (sint32)input.a;
                state.mut().fromByte = (sint64)locals.asByte;
                state.mut().fromWord = (sint64)locals.asWord;
                state.mut().fromDouble = (sint64)locals.asDouble;
                state.mut().allNegative = state.get().fromByte < 0 && state.get().fromWord < 0 && state.get().fromDouble < 0 ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [127n, 0n],
                [255n, 0n],
                [65535n, 0n],
                [4294967295n, 0n],
                [2147483648n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 0n], note: "zero everywhere" },
                { pair: 1, values: [127n, 127n, 127n, 0n], note: "positive at every width" },
                { pair: 2, values: [-1n, 255n, 255n, 0n], note: "0xFF is -1 at eight bits and positive above" },
                { pair: 3, values: [-1n, -1n, 65535n, 0n], note: "0xFFFF is -1 at eight and sixteen bits" },
                { pair: 4, values: [-1n, -1n, -1n, 1n], note: "0xFFFFFFFF is -1 at all three" },
                { pair: 5, values: [0n, 0n, -2147483648n, 0n], note: "2^31 is negative only at 32 bits" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedComparisonChain",
            family: "integers",
            solidity: `${SOL}/expressions/comparison_operators.sol`,
            stresses:
                "all six comparison operators evaluated on one signed pair and packed into a bitfield, so a single wrong comparison changes one bit of a number",
        },
        () => ({
            state: "uint64 packed;\nuint64 trueCount;\nsint64 lhs;\nsint64 rhs;",
            locals: "sint64 left;\nsint64 right;\nuint64 bits;",
            body: `
                locals.left = (sint64)input.a;
                locals.right = (sint64)input.b;
                locals.bits = 0;
                locals.bits = locals.bits | (locals.left < locals.right ? 1ULL : 0ULL);
                locals.bits = locals.bits | (locals.left <= locals.right ? 2ULL : 0ULL);
                locals.bits = locals.bits | (locals.left == locals.right ? 4ULL : 0ULL);
                locals.bits = locals.bits | (locals.left != locals.right ? 8ULL : 0ULL);
                locals.bits = locals.bits | (locals.left >= locals.right ? 16ULL : 0ULL);
                locals.bits = locals.bits | (locals.left > locals.right ? 32ULL : 0ULL);
                state.mut().packed = locals.bits;
                state.mut().trueCount = (locals.bits & 1) + ((locals.bits >> 1) & 1) + ((locals.bits >> 2) & 1) + ((locals.bits >> 3) & 1) + ((locals.bits >> 4) & 1) + ((locals.bits >> 5) & 1);
                state.mut().lhs = locals.left;
                state.mut().rhs = locals.right;
            `,
            pairs: SIGNED_PAIRS,
            expect: [
                { pair: 0, values: [22n, 3n, 0n, 0n], note: "equal: <=, ==, >= hold, which is bits 2+4+16" },
                { pair: 1, values: [56n, 3n, 7n, 3n], note: "greater: !=, >= and > hold, which is 8 + 16 + 32" },
                { pair: 2, values: [11n, 3n, -7n, 3n], note: "less: <, <=, != hold" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedMultiplyOverflowProbe",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/Math.sol (tryMul)",
            stresses: "signed multiplication with the division check libraries use to detect overflow, on operands that reach the extremes in both signs",
        },
        () => ({
            state: "sint64 product;\nuint64 overflowed;\nsint64 recovered;\nuint64 exact;",
            locals: "sint64 lhs;\nsint64 rhs;",
            body: `
                locals.lhs = (sint64)input.a;
                locals.rhs = (sint64)input.b;
                state.mut().product = locals.lhs * locals.rhs;
                if (locals.lhs == 0)
                {
                    state.mut().overflowed = 0;
                    state.mut().recovered = 0;
                    state.mut().exact = 1;
                }
                else
                {
                    state.mut().recovered = QPI::div(state.get().product, locals.lhs);
                    state.mut().overflowed = state.get().recovered != locals.rhs ? 1 : 0;
                    state.mut().exact = state.get().recovered == locals.rhs ? 1 : 0;
                }
            `,
            pairs: [
                [0n, 5n],
                [3n, 4n],
                [-3n, 4n],
                [4294967296n, 4294967296n],
                [-9223372036854775808n, 2n],
                [9223372036854775807n, 2n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 1n], note: "a zero operand short-circuits the check" },
                { pair: 1, values: [12n, 0n, 4n, 1n], note: "3 * 4 recovers exactly" },
                { pair: 2, values: [-12n, 0n, 4n, 1n], note: "sign does not disturb the recovery" },
                { pair: 3, values: [0n, 1n, 0n, 0n], note: "2^32 squared wraps to zero and is detected" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedToUnsignedRoundTrip",
            family: "integers",
            solidity: `${SOL}/types/mixed_signed_unsigned_comparison.sol`,
            stresses:
                "a signed value cast to unsigned and back, with the bit pattern preserved through both hops — and the same value compared before and after, where the ordering reverses",
        },
        () => ({
            state: "uint64 asUnsigned;\nsint64 backAgain;\nuint64 roundTrips;\nuint64 orderingFlipped;",
            locals: "sint64 value;\nuint64 unsignedValue;",
            body: `
                locals.value = (sint64)input.a;
                locals.unsignedValue = (uint64)locals.value;
                state.mut().asUnsigned = locals.unsignedValue;
                state.mut().backAgain = (sint64)locals.unsignedValue;
                state.mut().roundTrips = state.get().backAgain == locals.value ? 1 : 0;
                state.mut().orderingFlipped = (locals.value < 0) && (locals.unsignedValue > 9223372036854775807ULL) ? 1 : 0;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [-1n, 0n],
                [9223372036854775807n, 0n],
                [-9223372036854775808n, 0n],
                [-42n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 1n, 0n], note: "zero round-trips" },
                { pair: 2, values: [18446744073709551615n, -1n, 1n, 1n], note: "-1 is 2^64-1 unsigned, and the ordering flips" },
                { pair: 4, values: [9223372036854775808n, -9223372036854775808n, 1n, 1n], note: "the minimum is 2^63 unsigned" },
                { pair: 5, values: [18446744073709551574n, -42n, 1n, 1n], note: "-42 round-trips through the unsigned representation" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedAccumulatorAcrossZero",
            family: "integers",
            solidity: `${SOL}/arithmetics/signed_accumulation.sol`,
            stresses:
                "an accumulator driven across zero in both directions with the crossing counted — the one archetype here that does accumulate, so its state depends on the whole script rather than one pair",
        },
        () => ({
            state: "sint64 total;\nuint64 crossings;\nsint64 lowWater;\nsint64 highWater;",
            locals: "sint64 before;\nsint64 delta;",
            body: `
                locals.before = state.get().total;
                locals.delta = (sint64)input.a;
                state.mut().total = locals.before + locals.delta;
                if ((locals.before < 0) != (state.get().total < 0))
                {
                    state.mut().crossings++;
                }
                if (state.get().total < state.get().lowWater)
                {
                    state.mut().lowWater = state.get().total;
                }
                if (state.get().total > state.get().highWater)
                {
                    state.mut().highWater = state.get().total;
                }
            `,
            pairs: [
                [5n, 0n],
                [-10n, 0n],
                [3n, 0n],
                [20n, 0n],
                [-18n, 0n],
                [0n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedBitwiseComplementLadder",
            family: "integers",
            solidity: `${SOL}/various/bit_operations.sol`,
            stresses:
                "the identity `~x == -x - 1` checked at four widths, which only holds if the complement and the negation agree about where the sign bit is",
        },
        () => ({
            state: "sint64 complement;\nsint64 negated;\nuint64 identityHolds;\nsint64 narrowComplement;",
            locals: "sint64 value;\nsint8 narrow;",
            body: `
                locals.value = (sint64)input.a;
                locals.narrow = (sint8)input.a;
                state.mut().complement = ~locals.value;
                state.mut().negated = (0 - locals.value) - 1;
                state.mut().identityHolds = state.get().complement == state.get().negated ? 1 : 0;
                state.mut().narrowComplement = (sint64)(sint8)(~locals.narrow);
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [-1n, 0n],
                [127n, 0n],
                [-128n, 0n],
                [9223372036854775807n, 0n],
            ],
            expect: [
                { pair: 0, values: [-1n, -1n, 1n, -1n], note: "~0 = -1" },
                { pair: 1, values: [-2n, -2n, 1n, -2n], note: "~1 = -2" },
                { pair: 2, values: [0n, 0n, 1n, 0n], note: "~-1 = 0" },
                { pair: 3, values: [-128n, -128n, 1n, -128n], note: "~127 = -128 at both widths" },
                { pair: 4, values: [127n, 127n, 1n, 127n], note: "~-128 = 127" },
                {
                    pair: 5,
                    values: [-9223372036854775808n, -9223372036854775808n, 1n, 0n],
                    note: "the identity holds at the extreme; the low byte is 0xFF, whose complement is 0",
                },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedPowerByRepeatedSquaring",
            family: "integers",
            solidity: `${SOL}/arithmetics/exp_signed.sol`,
            stresses:
                "signed exponentiation by squaring, where the sign of the result depends on the parity of the exponent and the magnitude wraps long before the exponent is exhausted",
        },
        () => ({
            state: "sint64 result;\nuint64 iterations;\nuint64 wrapped;\nsint64 base;",
            locals: "sint64 accumulator;\nsint64 factor;\nuint64 exponent;\nuint64 steps;",
            body: `
                locals.accumulator = 1;
                locals.factor = (sint64)input.a;
                locals.exponent = input.b & 63ULL;
                locals.steps = 0;
                while (locals.exponent != 0)
                {
                    if ((locals.exponent & 1ULL) != 0)
                    {
                        locals.accumulator = locals.accumulator * locals.factor;
                    }
                    locals.factor = locals.factor * locals.factor;
                    locals.exponent = locals.exponent >> 1;
                    locals.steps++;
                }
                state.mut().result = locals.accumulator;
                state.mut().iterations = locals.steps;
                state.mut().base = (sint64)input.a;
                state.mut().wrapped = locals.accumulator != 0 && (input.b & 63ULL) > 20 ? 1 : 0;
            `,
            pairs: [
                [2n, 0n],
                [2n, 10n],
                [-2n, 3n],
                [-2n, 4n],
                [3n, 5n],
                [-1n, 63n],
            ],
            expect: [
                { pair: 0, values: [1n, 0n, 0n, 2n], note: "anything to the zeroth power is 1" },
                { pair: 1, values: [1024n, 4n, 0n, 2n], note: "2^10, four squaring steps" },
                { pair: 2, values: [-8n, 2n, 0n, -2n], note: "an odd exponent keeps the sign" },
                { pair: 3, values: [16n, 3n, 0n, -2n], note: "an even exponent drops it" },
                { pair: 4, values: [243n, 3n, 0n, 3n], note: "3^5" },
                { pair: 5, values: [-1n, 6n, 1n, -1n], note: "(-1)^63 is -1" },
            ],
        }),
    ),
];
