// Shift semantics.
//
// Ported from Solidity's `operators/shifts/*` and `cleanup/*`. Two things make this family worth its own
// file. First, Solidity defines `x << n` for every `n`, while C++ leaves `n >= width` undefined — so a
// backend disagreement at exactly the width boundary is expected signal rather than a port error, and
// the archetypes drive that boundary deliberately. Second, Solidity's own test comments state the
// intent: `shift_left_larger_type.sol` says "It should not convert x to int8", which is precisely the
// operand-width question a code generator gets wrong.

import { emitContract } from "../emit";
import { operandFor, widthOf } from "../axes";
import { script } from "./common";
import { maxOf, minOf, scalar } from "../encode";
import type { Archetype, AxisAssignment, CallStep, ScalarWidth } from "../types";

const SOL = "test/libsolidity/semanticTests/operators/shifts";

/** Shift counts worth driving: inside the width, exactly at it, just past it, and absurdly past it. */
const SHIFT_COUNTS = [0, 1, 7, 15, 31, 63, 64, 65, 200, 255];

function signedOf(width: ScalarWidth): ScalarWidth {
    return width.startsWith("sint") ? width : (width.replace("uint", "sint") as ScalarWidth);
}

function unsignedOf(width: ScalarWidth): ScalarWidth {
    return width.startsWith("uint") ? width : (width.replace("sint", "uint") as ScalarWidth);
}

/**
 * One shift operator applied at a chosen width, with the result stored both wide and narrow so the
 * promotion is observable, and the shift count taken from a separate uint8 so it cannot be folded into
 * the operand's type.
 */
function shiftArchetype(
    name: string,
    solidity: string,
    stresses: string,
    caveat: string | undefined,
    operator: "<<" | ">>",
    signedOperand: boolean,
): Archetype {
    return {
        name,
        family: "integers",
        solidity,
        stresses,
        caveat,
        axes: ["width", "placement", "temporaries"],
        build(axis: AxisAssignment) {
            const base = widthOf(axis, signedOperand ? "sint32" : "uint32");
            const width = signedOperand ? signedOf(base) : unsignedOf(base);
            const accumulator = signedOperand ? "sint64" : "uint64";
            const source = emitContract({
                name,
                header: { archetype: name, family: "integers", solidity, stresses, caveat, axis: `width=${width}` },
                state: `${accumulator} wide;\n${width} narrow;\nuint64 applied;`,
                statePlacement: axis.placement,
                temporaries: axis.temporaries,
                entries: [
                    {
                        name: "Shift",
                        kind: "procedure",
                        number: 1,
                        // The count is uint8 on purpose: Solidity's shift_left_larger_type asserts the RHS
                        // is not narrowed to the LHS type, and a uint8 count makes that visible.
                        input: `${width} value;\nuint8 count;`,
                        locals: `${width} shifted;`,
                        body: `
                            locals.shifted = input.value ${operator} input.count;
                            state.mut().narrow = locals.shifted;
                            state.mut().wide = (${accumulator})locals.shifted;
                            state.mut().applied++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${accumulator} wide;\n${width} narrow;\nuint64 applied;`,
                        body: "output.wide = state.get().wide;\noutput.narrow = state.get().narrow;\noutput.applied = state.get().applied;",
                    },
                ],
                initialize: "state.mut().wide = 0;\nstate.mut().narrow = 0;\nstate.mut().applied = 0;",
            });

            const values = signedOperand ? [minOf(width), -1n, 1n, maxOf(width)] : [1n, maxOf(width) >> 1n, maxOf(width)];
            const steps: CallStep[] = [];
            for (const value of values) {
                for (const count of SHIFT_COUNTS) {
                    steps.push({
                        kind: "procedure",
                        entry: 1,
                        in: scalar(width, value) + scalar("uint8", BigInt(count)),
                        invocator: 0,
                        note: `${value} ${operator} ${count}`,
                    });
                }
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    };
}

export const SHIFT_ARCHETYPES: Archetype[] = [
    shiftArchetype(
        "ShiftLeftUnsigned",
        `${SOL}/shift_left.sol`,
        "left shift across every width, including counts equal to and beyond the operand width",
        "Solidity defines a shift by any count; C++ leaves count >= width undefined, so a disagreement at the boundary is signal, not a port error.",
        "<<",
        false,
    ),
    shiftArchetype(
        "ShiftRightUnsigned",
        `${SOL}/shift_right.sol`,
        "logical right shift on unsigned operands — no sign bit to propagate",
        undefined,
        ">>",
        false,
    ),
    shiftArchetype(
        "ShiftLeftSigned",
        `${SOL}/shift_overflow.sol`,
        "left shift into and past the sign bit; `int8(1) << 7` is -128 after the narrowing store",
        "Solidity 0.8 permits it and wraps; the port asserts the wrapped value.",
        "<<",
        true,
    ),
    shiftArchetype(
        "ShiftRightSignedArithmetic",
        `${SOL}/shift_right_negative_lvalue_int8.sol`,
        "arithmetic vs logical right shift on a negative operand — the sign bit must propagate",
        undefined,
        ">>",
        true,
    ),

    {
        name: "ShiftRhsWiderThanLhs",
        family: "integers",
        solidity: `${SOL}/shift_left_larger_type.sol`,
        stresses: "the shift count must not be narrowed to the operand's type — the Solidity test's own comment says 'It should not convert x to int8'",
        caveat: "Solidity's expected result is 0 for `int8(1) << uint8(254)`; in C++ that count is past the width and undefined, so the two backends agreeing is the assertion.",
        axes: ["width", "constSource"],
        build(axis) {
            const width = widthOf(axis, "sint8");
            const count = operandFor(axis, "input.count", "FIXED_COUNT", "uint8", 254n);
            const source = emitContract({
                name: "ShiftRhsWiderThanLhs",
                header: {
                    archetype: "ShiftRhsWiderThanLhs",
                    family: "integers",
                    solidity: `${SOL}/shift_left_larger_type.sol`,
                    stresses: "a shift count wider than the operand",
                    axis: `width=${width} constSource=${axis.constSource ?? "input"}`,
                },
                prelude: count.prelude,
                state: `sint64 wide;\n${width} narrow;`,
                entries: [
                    {
                        name: "Shift",
                        kind: "procedure",
                        number: 1,
                        input: `${width} value;\nuint8 count;`,
                        locals: `${width} shifted;`,
                        body: `
                            locals.shifted = input.value << ${count.use};
                            state.mut().narrow = locals.shifted;
                            state.mut().wide = (sint64)locals.shifted;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `sint64 wide;\n${width} narrow;`,
                        body: "output.wide = state.get().wide;\noutput.narrow = state.get().narrow;",
                    },
                ],
                initialize: "state.mut().wide = 0;\nstate.mut().narrow = 0;",
            });
            const steps: CallStep[] = [];
            for (const c of [1, 7, 8, 254]) {
                steps.push({ kind: "procedure", entry: 1, in: scalar(width, 1n) + scalar("uint8", BigInt(c)), invocator: 0, note: `1 << ${c}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "ShiftCleanupChain",
        family: "integers",
        solidity: "test/libsolidity/semanticTests/operators/shifts/shift_cleanup.sol",
        stresses: "a chain of compound shifts on a narrow field: `x = 0xffff; x += 32; x <<= 8; x >>= 16` must end at 0, not carry promoted bits",
        caveat: "Solidity needs `unchecked` for the add; QPI wraps natively, so the chain is written directly.",
        axes: ["width", "placement", "temporaries"],
        build(axis) {
            const width = widthOf(axis, "uint16");
            const source = emitContract({
                name: "ShiftCleanupChain",
                header: {
                    archetype: "ShiftCleanupChain",
                    family: "integers",
                    solidity: "operators/shifts/shift_cleanup.sol",
                    stresses: "compound shift chain on a narrow field",
                    axis: `width=${width}`,
                },
                state: `${width} value;\nuint64 witness;`,
                statePlacement: axis.placement,
                temporaries: axis.temporaries,
                entries: [
                    {
                        name: "Chain",
                        kind: "procedure",
                        number: 1,
                        input: `${width} seed;\nuint8 addend;`,
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().value = input.seed;
                            state.mut().value += input.addend;
                            state.mut().value <<= 8;
                            state.mut().value >>= 16;
                            locals.scratch = (uint64)state.get().value;
                            state.mut().witness = locals.scratch;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${width} value;\nuint64 witness;`,
                        body: "output.value = state.get().value;\noutput.witness = state.get().witness;",
                    },
                ],
                initialize: "state.mut().value = 0;\nstate.mut().witness = 0;",
            });
            const steps: CallStep[] = [];
            for (const [seed, addend] of [
                [maxOf(width), 32n],
                [maxOf(width), 0n],
                [0n, 1n],
                [maxOf(width) >> 1n, 255n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: scalar(width, seed) + scalar("uint8", addend), invocator: 0, note: `${seed} + ${addend}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "ShiftCountFromState",
        family: "integers",
        solidity: `${SOL}/shift_underflow_negative_rvalue.sol`,
        stresses: "a shift count the compiler cannot constant-fold, because it is read back out of contract state",
        axes: ["width", "placement"],
        build(axis) {
            const width = widthOf(axis, "uint64");
            const source = emitContract({
                name: "ShiftCountFromState",
                header: {
                    archetype: "ShiftCountFromState",
                    family: "integers",
                    solidity: `${SOL}/shift_underflow_negative_rvalue.sol`,
                    stresses: "an unfoldable shift count",
                    axis: `width=${width}`,
                },
                state: `uint8 count;\n${width} value;\nuint64 witness;`,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "SetCount",
                        kind: "procedure",
                        number: 1,
                        input: "uint8 count;",
                        locals: "uint64 scratch;",
                        body: "state.mut().count = input.count;",
                    },
                    {
                        name: "Apply",
                        kind: "procedure",
                        number: 2,
                        input: `${width} value;`,
                        locals: `${width} shifted;`,
                        body: `
                            locals.shifted = input.value << state.get().count;
                            state.mut().value = locals.shifted;
                            locals.shifted = input.value >> state.get().count;
                            state.mut().witness = (uint64)locals.shifted;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${width} value;\nuint64 witness;`,
                        body: "output.value = state.get().value;\noutput.witness = state.get().witness;",
                    },
                ],
                initialize: "state.mut().count = 0;\nstate.mut().value = 0;\nstate.mut().witness = 0;",
            });
            const steps: CallStep[] = [];
            for (const count of [0, 1, 63, 64, 200]) {
                steps.push({ kind: "procedure", entry: 1, in: scalar("uint8", BigInt(count)), invocator: 0, note: `count ${count}` });
                steps.push({ kind: "procedure", entry: 2, in: scalar(width, maxOf(width)), invocator: 0 });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "PowExponentNotNarrowed",
        family: "integers",
        solidity: "test/libsolidity/semanticTests/cleanup/exp_cleanup_smaller_base.sol",
        stresses: "an exponent wider than the base: `uint8 ** uint16` must keep the exponent's width, so a 0x100 exponent is not truncated to 0",
        caveat: "QPI has no `**`; the port is a bounded square-and-multiply loop, and the bug surface moves to the loop counter's type.",
        axes: ["width", "loopShape", "placement"],
        build(axis) {
            const width = widthOf(axis, "uint8");
            const source = emitContract({
                name: "PowExponentNotNarrowed",
                header: {
                    archetype: "PowExponentNotNarrowed",
                    family: "integers",
                    solidity: "cleanup/exp_cleanup_smaller_base.sol",
                    stresses: "exponent width in a hand-written pow",
                    caveat: "no ** operator in QPI; a bounded loop stands in",
                    axis: `width=${width}`,
                },
                state: `${width} result;\nuint64 iterations;`,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Pow",
                        kind: "procedure",
                        number: 1,
                        input: `${width} base;\nuint16 exponent;`,
                        locals: `${width} accumulator;\nuint64 i;\nuint64 bound;`,
                        body: `
                            locals.accumulator = 1;
                            // The exponent is uint16 and the base narrower: the loop bound must not be
                            // truncated to the base's width, which is exactly the Solidity test's point.
                            locals.bound = input.exponent;
                            if (locals.bound > 512)
                            {
                                locals.bound = 512;
                            }
                            for (locals.i = 0; locals.i < locals.bound; locals.i++)
                            {
                                locals.accumulator = locals.accumulator * input.base;
                            }
                            state.mut().result = locals.accumulator;
                            state.mut().iterations = locals.bound;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${width} result;\nuint64 iterations;`,
                        body: "output.result = state.get().result;\noutput.iterations = state.get().iterations;",
                    },
                ],
                initialize: "state.mut().result = 0;\nstate.mut().iterations = 0;",
            });
            const steps: CallStep[] = [];
            for (const [base, exponent] of [
                [2n, 0x100n],
                [2n, 2n],
                [3n, 5n],
                [0n, 0n],
                [maxOf(width), 2n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: scalar(width, base) + scalar("uint16", exponent), invocator: 0, note: `${base} ** ${exponent}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },
];
