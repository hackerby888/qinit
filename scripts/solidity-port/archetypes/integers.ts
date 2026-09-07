// Integer semantics, promotion, width and signedness.
//
// Ported from Solidity's `arithmetics`, `integer`, `cleanup`, `conversions` and `operators` semantic
// tests. Solidity 0.8 reverts on overflow and panics on division by zero; QPI does neither — it wraps,
// and `QPI::div`/`QPI::mod` return 0 for a zero divisor. Every archetype here therefore asserts the
// *observed wrapped value* rather than a revert, and the pair of wide/narrow state fields is what makes
// C++'s integer promotion visible: both operands widen to `int` before the operator runs.

import { binaryOpArchetype, script, singleProcedureArchetype } from "./common";
import { emitContract } from "../emit";
import { maxOf, minOf, scalar, u64, u128 } from "../encode";
import { widthOf } from "../axes";
import type { Archetype, CallStep, ScalarWidth } from "../types";

const SOL = "test/libsolidity/semanticTests";

export const INTEGER_ARCHETYPES: Archetype[] = [
    binaryOpArchetype(
        {
            name: "PromoteAdd",
            family: "integers",
            solidity: `${SOL}/arithmetics/checked_add_v2.sol`,
            stresses: "integer promotion on +: both operands widen to int, so the wide and narrow fields disagree for uint8/uint16",
            caveat: "Solidity 0.8 reverts on overflow (`FAILURE, hex\"4e487b71\", 0x11`); QPI wraps, so the wrapped value is asserted instead.",
        },
        { expression: (a, b) => `${a} + ${b}` },
    ),
    binaryOpArchetype(
        {
            name: "PromoteSub",
            family: "integers",
            solidity: `${SOL}/arithmetics/checked_sub.sol`,
            stresses: "underflow wrap and promotion on -",
            caveat: "Solidity reverts on underflow; QPI wraps.",
        },
        { expression: (a, b) => `${a} - ${b}` },
    ),
    binaryOpArchetype(
        {
            name: "PromoteMul",
            family: "integers",
            solidity: `${SOL}/arithmetics/checked_mul.sol`,
            stresses: "overflow wrap and promotion on *; the narrow field truncates a product the wide field keeps",
            caveat: "Solidity reverts on overflow; QPI wraps.",
        },
        { expression: (a, b) => `${a} * ${b}` },
    ),
    binaryOpArchetype(
        {
            name: "DivQpi",
            family: "integers",
            solidity: `${SOL}/arithmetics/divisiod_by_zero.sol`,
            stresses: "QPI::div truncation toward zero, including the signed cases",
            caveat: "Solidity panics 0x12 on a zero divisor; QPI::div returns 0. Covered by DivByZero; here the divisor is non-zero.",
        },
        { expression: (a, b) => `QPI::div(${a}, ${b})`, avoidZeroDivisor: true },
    ),
    binaryOpArchetype(
        {
            name: "ModQpi",
            family: "integers",
            solidity: `${SOL}/arithmetics/mod.sol`,
            stresses: "QPI::mod sign rules — the result takes the dividend's sign in C++",
            caveat: "Solidity panics 0x12 on a zero divisor; QPI::mod returns 0.",
        },
        { expression: (a, b) => `QPI::mod(${a}, ${b})`, avoidZeroDivisor: true },
    ),
    binaryOpArchetype(
        {
            name: "BitwiseAnd",
            family: "integers",
            solidity: `${SOL}/operators/bitwise.sol`,
            stresses: "& across widths, and the high bits a narrowing store must clear",
        },
        { expression: (a, b) => `${a} & ${b}` },
    ),
    binaryOpArchetype(
        {
            name: "BitwiseOr",
            family: "integers",
            solidity: `${SOL}/operators/bitwise.sol`,
            stresses: "| across widths",
        },
        { expression: (a, b) => `${a} | ${b}` },
    ),
    binaryOpArchetype(
        {
            name: "BitwiseXor",
            family: "integers",
            solidity: `${SOL}/operators/bitwise.sol`,
            stresses: "^ across widths",
        },
        { expression: (a, b) => `${a} ^ ${b}` },
    ),
    binaryOpArchetype(
        {
            name: "CompareLess",
            family: "integers",
            solidity: `${SOL}/operators/comparison.sol`,
            stresses: "signed/unsigned comparison after promotion — the case where -1 < 1 flips",
        },
        { expression: (a, b) => `(${a} < ${b}) ? 1 : 0` },
    ),
    binaryOpArchetype(
        {
            name: "CompareEqual",
            family: "integers",
            solidity: `${SOL}/operators/comparison.sol`,
            stresses: "== after promotion, including a narrow value compared against a wide one",
        },
        { expression: (a, b) => `(${a} == ${b}) ? 1 : 0` },
    ),

    // Division and modulo by zero: QPI's defined-zero answer, where Solidity panics. Split out from the
    // operator archetypes because the divisor has to be exactly zero.
    singleProcedureArchetype(
        {
            name: "DivByZero",
            family: "integers",
            solidity: `${SOL}/arithmetics/divisiod_by_zero.sol`,
            stresses: "QPI::div(x, 0) is defined as 0 rather than a trap — the opposite of Solidity's panic 0x12",
            caveat: "Solidity panics; QPI returns 0. The port asserts the defined-zero answer.",
            axes: ["width"],
        },
        (axis) => {
            const width = widthOf(axis, "uint64");
            return {
                input: `${width} value;`,
                locals: "uint64 scratch;",
                body: `
                    state.mut().accumulator += QPI::div(input.value, ${zeroLiteral(width)});
                    state.mut().accumulator += QPI::mod(input.value, ${zeroLiteral(width)});
                `,
                steps: driveValues(width, [maxOf(width), 1n, 0n]),
            };
        },
    ),
    singleProcedureArchetype(
        {
            name: "SignedMinDivMinusOne",
            family: "integers",
            solidity: `${SOL}/arithmetics/signed_division.sol`,
            stresses: "INT_MIN / -1, the one signed division that genuinely overflows and traps on wasm",
            caveat: "Solidity panics 0x11; on wasm this is a real trap, so both backends must trap at the same step.",
            axes: [],
        },
        () => ({
            input: "sint64 value;\nsint64 divisor;",
            locals: "sint64 scratch;",
            body: `
                locals.scratch = QPI::div(input.value, input.divisor);
                state.mut().accumulator += (uint64)locals.scratch;
            `,
            steps: [
                { kind: "procedure", entry: 1, in: scalar("sint64", -5n) + scalar("sint64", 2n), invocator: 0, note: "control: -5 / 2 truncates toward zero" },
                { kind: "function", entry: 1 },
                {
                    kind: "procedure",
                    entry: 1,
                    in: scalar("sint64", minOf("sint64")) + scalar("sint64", -1n),
                    invocator: 0,
                    note: "INT64_MIN / -1 — the trapping case",
                },
                { kind: "function", entry: 1 },
            ],
        }),
    ),
    singleProcedureArchetype(
        {
            name: "ShiftByWidthAndBeyond",
            family: "integers",
            solidity: `${SOL}/operators/shifts/shift_overflow.sol`,
            stresses: "a shift count equal to and greater than the operand width — undefined in C++, defined in Solidity",
            caveat: "Solidity defines `x << n` for every n; C++ leaves n >= width undefined, so a backend disagreement here is expected signal, not a port error.",
            axes: ["width"],
        },
        (axis) => {
            const width = widthOf(axis, "uint64");
            return {
                input: `${width} value;\nuint8 amount;`,
                locals: `${width} scratch;`,
                body: `
                    locals.scratch = input.value << input.amount;
                    state.mut().accumulator += (uint64)locals.scratch;
                    locals.scratch = input.value >> input.amount;
                    state.mut().accumulator += (uint64)locals.scratch;
                `,
                steps: [0, 1, 7, 31, 63, 64, 200].flatMap((amount): CallStep[] => [
                    { kind: "procedure", entry: 1, in: scalar(width, maxOf(width)) + scalar("uint8", BigInt(amount)), invocator: 0, note: `shift by ${amount}` },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    ),
    singleProcedureArchetype(
        {
            name: "NarrowingRoundTrip",
            family: "integers",
            solidity: `${SOL}/cleanup/cleanup_during_multi_assignment.sol`,
            stresses: "narrow-then-widen: the high bits a narrowing store must clear before the value is read back wide",
            caveat: "Solidity's `uint8(uint256(x))` becomes a cast through the QPI widths; the truncation point is the same.",
            axes: ["width", "placement"],
        },
        (axis) => {
            const width = widthOf(axis, "uint8");
            return {
                extraState: `${width} narrow;\nuint64 widened;`,
                input: "uint64 value;",
                locals: `${width} scratch;`,
                body: `
                    locals.scratch = (${width})input.value;
                    state.mut().narrow = locals.scratch;
                    state.mut().widened = (uint64)state.get().narrow;
                    state.mut().accumulator += state.get().widened;
                `,
                steps: [0n, 1n, 255n, 256n, 65535n, 65536n, 4294967295n, 4294967296n, 18446744073709551615n].flatMap((value): CallStep[] => [
                    { kind: "procedure", entry: 1, in: u64(value), invocator: 0, note: `truncate ${value}` },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    ),
    singleProcedureArchetype(
        {
            name: "SignExtendWidening",
            family: "integers",
            solidity: `${SOL}/types/convert_signed_to_wider.sol`,
            stresses: "sign extension when a negative narrow value widens — the bug that shows up as a huge positive number",
            axes: ["width"],
        },
        (axis) => {
            const width = signedOf(widthOf(axis, "sint8"));
            return {
                extraState: `${width} narrow;\nsint64 widened;`,
                input: `${width} value;`,
                locals: "sint64 scratch;",
                body: `
                    state.mut().narrow = input.value;
                    locals.scratch = (sint64)state.get().narrow;
                    state.mut().widened = locals.scratch;
                    state.mut().accumulator += (uint64)locals.scratch;
                `,
                steps: [minOf(width), minOf(width) + 1n, -1n, 0n, 1n, maxOf(width)].flatMap((value): CallStep[] => [
                    { kind: "procedure", entry: 1, in: scalar(width, value), invocator: 0, note: `widen ${value}` },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    ),
    singleProcedureArchetype(
        {
            name: "CompoundAssignNarrow",
            family: "integers",
            solidity: `${SOL}/operators/compound_assignment.sol`,
            stresses: "`a += b` on a narrow field: the promotion happens, then the result is truncated back on store",
            axes: ["width", "placement"],
        },
        (axis) => {
            const width = widthOf(axis, "uint8");
            return {
                extraState: `${width} narrow;`,
                input: `${width} delta;`,
                locals: "uint64 scratch;",
                body: `
                    state.mut().narrow += input.delta;
                    state.mut().accumulator += (uint64)state.get().narrow;
                `,
                steps: driveValues(width, [maxOf(width), 1n, 1n, maxOf(width), 2n]),
            };
        },
    ),
    singleProcedureArchetype(
        {
            name: "IncrementWrapAtMax",
            family: "integers",
            solidity: `${SOL}/arithmetics/checked_inc_dec.sol`,
            stresses: "++ at the type's maximum and -- at its minimum, both wrapping",
            caveat: "Solidity 0.8 reverts on both; QPI wraps.",
            axes: ["width"],
        },
        (axis) => {
            const width = widthOf(axis, "uint8");
            return {
                extraState: `${width} up;\n${width} down;`,
                input: "uint8 rounds;",
                locals: "uint64 i;",
                body: `
                    for (locals.i = 0; locals.i < input.rounds; locals.i++)
                    {
                        state.mut().up++;
                        state.mut().down--;
                    }
                    state.mut().accumulator = (uint64)state.get().up;
                `,
                initialize: `state.mut().accumulator = 0;\nstate.mut().calls = 0;\nstate.mut().up = ${literal(width, maxOf(width) - 1n)};\nstate.mut().down = 0;`,
                steps: [1, 1, 1, 4].flatMap((rounds): CallStep[] => [
                    { kind: "procedure", entry: 1, in: scalar("uint8", BigInt(rounds)), invocator: 0, note: `${rounds} increments across the wrap` },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    ),
    singleProcedureArchetype(
        {
            name: "ConstexprFoldVsRuntime",
            family: "integers",
            solidity: `${SOL}/constantEvaluator/rounding.sol`,
            stresses: "the same expression constant-folded and computed at runtime — a fold that disagrees with the emitted code is silent",
            axes: ["width"],
        },
        (axis) => {
            const width = widthOf(axis, "uint8");
            const max = maxOf(width);
            return {
                extraState: `${width} folded;\n${width} computed;\nuint64 agree;`,
                input: `${width} a;\n${width} b;`,
                locals: `${width} scratch;`,
                body: `
                    state.mut().folded = (${width})(${max} + 3);
                    locals.scratch = input.a + input.b;
                    state.mut().computed = locals.scratch;
                    state.mut().agree = (state.get().folded == state.get().computed) ? 1 : 0;
                    state.mut().accumulator += state.get().agree;
                `,
                steps: drivePairs(width, [
                    [max, 3n],
                    [max, 4n],
                    [0n, 0n],
                ]),
            };
        },
    ),
    singleProcedureArchetype(
        {
            name: "U128AddCarry",
            family: "integers",
            solidity: `${SOL}/arithmetics/checked_add_v2.sol`,
            stresses: "uint128 addition across the 64-bit limb boundary — the carry the wide type needs and uint64 cannot show",
            caveat: "Stands in for Solidity's uint256 where the value exceeds 64 bits; the boundary moves from 2^256 to 2^128.",
            axes: [],
        },
        () => ({
            extraState: "uint128 wide;",
            input: "uint128 a;\nuint128 b;",
            locals: "uint128 scratch;",
            body: `
                locals.scratch = input.a + input.b;
                state.mut().wide = locals.scratch;
                state.mut().accumulator++;
            `,
            steps: (
                [
                    [0n, 1n],
                    [(1n << 64n) - 1n, 1n],
                    [(1n << 64n) - 1n, (1n << 64n) - 1n],
                    [1n << 64n, 1n << 64n],
                    [(1n << 128n) - 1n, 1n],
                ] as [bigint, bigint][]
            ).flatMap(([a, b]): CallStep[] => [
                { kind: "procedure", entry: 1, in: u128(a) + u128(b), invocator: 0, note: `${a} + ${b} across the limb boundary` },
                { kind: "function", entry: 1 },
            ]),
        }),
    ),
    singleProcedureArchetype(
        {
            name: "MixedSignCompare",
            family: "integers",
            solidity: `${SOL}/types/mixed_signed_unsigned_comparison.sol`,
            stresses: "comparing a signed value against an unsigned one after the usual arithmetic conversions",
            axes: ["placement"],
        },
        () => ({
            extraState: "uint64 lessCount;\nuint64 greaterCount;",
            input: "sint64 signedValue;\nuint64 unsignedValue;",
            locals: "uint64 scratch;",
            body: `
                if ((sint64)input.unsignedValue > input.signedValue)
                {
                    state.mut().greaterCount++;
                }
                else
                {
                    state.mut().lessCount++;
                }
                state.mut().accumulator = state.get().greaterCount * 1000 + state.get().lessCount;
            `,
            steps: (
                [
                    [-1n, 1n],
                    [-1n, 18446744073709551615n],
                    [0n, 0n],
                    [minOf("sint64"), 1n],
                    [maxOf("sint64"), 18446744073709551615n],
                ] as [bigint, bigint][]
            ).flatMap(([signedValue, unsignedValue]): CallStep[] => [
                {
                    kind: "procedure",
                    entry: 1,
                    in: scalar("sint64", signedValue) + u64(unsignedValue),
                    invocator: 0,
                    note: `${signedValue} vs ${unsignedValue}`,
                },
                { kind: "function", entry: 1 },
            ]),
        }),
    ),
    singleProcedureArchetype(
        {
            name: "OverflowInLoopAccumulator",
            family: "integers",
            solidity: `${SOL}/arithmetics/overflow_in_loop.sol`,
            stresses: "an accumulator wrapping inside a bounded loop, where the trip count decides how far past the wrap it lands",
            axes: ["width", "loopShape"],
        },
        (axis) => {
            const width = widthOf(axis, "uint8");
            return {
                extraState: `${width} total;`,
                input: "uint64 rounds;\nuint64 step;",
                locals: "uint64 i;",
                body: `
                    for (locals.i = 0; locals.i < input.rounds; locals.i++)
                    {
                        state.mut().total += (${width})input.step;
                    }
                    state.mut().accumulator = (uint64)state.get().total;
                `,
                steps: (
                    [
                        [4n, 1n],
                        [64n, 7n],
                        [0n, 9n],
                        [300n, 3n],
                    ] as [bigint, bigint][]
                ).flatMap(([rounds, step]): CallStep[] => [
                    { kind: "procedure", entry: 1, in: u64(rounds) + u64(step), invocator: 0, note: `${rounds} x ${step}` },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    ),
    {
        name: "NegateUnsignedMinimum",
        family: "integers",
        solidity: `${SOL}/arithmetics/unary_operators.sol`,
        stresses: "unary minus on an unsigned zero and on the type maximum — the wrap C++ defines and Solidity 0.8 rejects",
        caveat: "Solidity 0.8 makes `-x` on an unsigned type a compile error; the port computes `0 - x` instead, which is the same wrap.",
        axes: ["width"],
        build(axis) {
            const width = widthOf(axis, "uint8");
            const source = emitContract({
                name: "NegateUnsignedMinimum",
                header: {
                    archetype: "NegateUnsignedMinimum",
                    family: "integers",
                    solidity: `${SOL}/arithmetics/unary_operators.sol`,
                    stresses: "0 - x on an unsigned type",
                    caveat: "Solidity rejects unary minus on unsigned; `0 - x` is the equivalent wrap.",
                    axis: `width=${width}`,
                },
                state: `${width} negated;\nuint64 widened;`,
                entries: [
                    {
                        name: "Negate",
                        kind: "procedure",
                        number: 1,
                        input: `${width} value;`,
                        locals: `${width} scratch;`,
                        body: `
                            locals.scratch = ${literal(width, 0n)} - input.value;
                            state.mut().negated = locals.scratch;
                            state.mut().widened = (uint64)locals.scratch;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${width} negated;\nuint64 widened;`,
                        body: "output.negated = state.get().negated;\noutput.widened = state.get().widened;",
                    },
                ],
                initialize: `state.mut().negated = 0;\nstate.mut().widened = 0;`,
            });
            return { source, script: script(driveValues(width, [0n, 1n, maxOf(width)])) };
        },
    },
];

function signedOf(width: ScalarWidth): ScalarWidth {
    return width.startsWith("sint") ? width : (width.replace("uint", "sint") as ScalarWidth);
}

function zeroLiteral(width: ScalarWidth): string {
    return `(${width})0`;
}

function literal(width: ScalarWidth, value: bigint): string {
    return `(${width})${value}`;
}

/** Drive one single-argument procedure over a list of values, reading state back after each. */
function driveValues(width: ScalarWidth, values: bigint[]): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry: 1, in: scalar(width, value), invocator: 0, note: `value ${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

/** The same, for a procedure taking two same-width arguments. */
function drivePairs(width: ScalarWidth, pairs: [bigint, bigint][]): CallStep[] {
    const steps: CallStep[] = [];
    for (const [a, b] of pairs) {
        steps.push({ kind: "procedure", entry: 1, in: scalar(width, a) + scalar(width, b), invocator: 0, note: `${a}, ${b}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}
