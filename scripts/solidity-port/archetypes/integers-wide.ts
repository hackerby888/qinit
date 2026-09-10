// Wide and bitwise arithmetic: the kernels every DeFi contract carries its own copy of.
//
// Ported from OpenZeppelin's `utils/math/Math.sol` (`mulDiv`, `sqrt`, `log2`, `average`), Solady's
// `LibBit`, and the 128-bit intermediate every AMM needs for `x * y / z`. Solidity gets a 256-bit word
// and QPI does not, so none of these port faithfully: the port keeps the *algorithm* and moves it to
// 64-bit lanes with an explicit hi/lo split, which is more demanding of the compiler than the original,
// not less — the carry and the shift boundaries become real code instead of one wide opcode.
//
// Each archetype drives the same computation twice where it can: once the obvious way and once through
// a second spelling, and stores both. A backend that gets one of them wrong disagrees with itself, so
// the row is informative even in the case where both backends make the same mistake.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const OZ = "openzeppelin-contracts/contracts/utils/math/Math.sol";

interface MathSpec {
    /** StateData members beyond the call counter. */
    state: string;
    /** `Run` body; input is `input.a` / `input.b`. */
    body: string;
    /** `Run` locals. */
    locals: string;
    /** `Read` output members, mirrored from state by name. */
    output: string;
    /** Operand pairs to drive. */
    pairs: [bigint, bigint][];
    /**
     * Expected `Read` outputs, derived by hand from the C++ rule rather than from either backend. This is
     * the campaign's secondary oracle: the digest comparison can only catch the two backends disagreeing,
     * while these rows catch them agreeing on a wrong answer.
     */
    expect?: { step: number; values: bigint[]; note: string }[];
}

/** The shape every archetype in this file shares: two uint64 operands in, several results in state. */
function wideArchetype(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, spec: (axis: AxisAssignment) => MathSpec): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["placement", "temporaries"],
        build(axis) {
            const shape = spec(axis);
            const mirrors = shape.output
                .split("\n")
                .map((line) => line.trim().replace(/;$/, "").split(/\s+/)[1])
                .filter((name) => name && name !== "calls");
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: "wide arithmetic",
                },
                state: `${shape.state}\nuint64 calls;`,
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
                        output: `${shape.output}\nuint64 calls;`,
                        body: [...mirrors.map((name) => `output.${name} = state.get().${name};`), "output.calls = state.get().calls;"].join("\n"),
                    },
                ],
                initialize: [...mirrors.map((name) => `state.mut().${name} = 0;`), "state.mut().calls = 0;"].join("\n"),
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
                    step: row.step,
                    out: row.values.map((value) => u64(value)).join(""),
                    source: "cpp-rule" as const,
                    note: row.note,
                }));
            }
            return { source, script: built };
        },
    };
}

const EDGE_PAIRS: [bigint, bigint][] = [
    [0n, 0n],
    [1n, 1n],
    [18446744073709551615n, 1n],
    [18446744073709551615n, 18446744073709551615n],
    [4294967296n, 4294967296n],
    [123456789n, 987654321n],
];

export const INTEGER_WIDE_ARCHETYPES: Archetype[] = [
    wideArchetype(
        {
            name: "WideMulDivViaLanes",
            family: "integers",
            solidity: `${OZ} (mulDiv)`,
            stresses: "a * b / c computed through a 32-bit lane split so the product never overflows, checked against the naive 64-bit spelling that does",
            caveat: "OpenZeppelin's mulDiv uses a 512-bit intermediate over uint256; the port uses a 64-bit intermediate over 32-bit lanes, which is the same algorithm one word down.",
        },
        () => ({
            state: "uint64 lanewise;\nuint64 naive;\nuint64 disagreements;\nuint64 overflows;",
            locals: "uint64 aHigh;\nuint64 aLow;\nuint64 product;\nuint64 divisor;\nuint64 naive;",
            output: "uint64 lanewise;\nuint64 naive;\nuint64 disagreements;\nuint64 overflows;",
            body: `
                locals.divisor = input.b == 0 ? 1 : input.b;
                locals.aHigh = input.a >> 32;
                locals.aLow = input.a & 4294967295ULL;
                // (aHigh * 2^32 + aLow) * 1000 / divisor, with the high lane divided before it is scaled.
                locals.product = QPI::div(locals.aHigh * 1000ULL, locals.divisor) << 32;
                locals.product += QPI::div(locals.aLow * 1000ULL, locals.divisor);
                locals.naive = QPI::div(input.a * 1000ULL, locals.divisor);
                if (input.a != 0 && QPI::div(input.a * 1000ULL, input.a) != 1000ULL)
                {
                    state.mut().overflows++;
                }
                state.mut().lanewise = locals.product;
                state.mut().naive = locals.naive;
                if (locals.product != locals.naive)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: EDGE_PAIRS,
        }),
    ),

    wideArchetype(
        {
            name: "WideGcdEuclid",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/Math.sol (gcd pattern)",
            stresses: "Euclid's algorithm over QPI::mod — a loop whose trip count depends on the operands, with the zero and equal-operand cases driven",
        },
        () => ({
            state: "uint64 gcd;\nuint64 iterations;\nuint64 coprimes;",
            locals: "uint64 x;\nuint64 y;\nuint64 t;\nuint64 guard;",
            output: "uint64 gcd;\nuint64 iterations;\nuint64 coprimes;",
            body: `
                locals.x = input.a;
                locals.y = input.b;
                locals.guard = 0;
                while (locals.y != 0 && locals.guard < 128)
                {
                    locals.t = QPI::mod(locals.x, locals.y);
                    locals.x = locals.y;
                    locals.y = locals.t;
                    locals.guard++;
                    state.mut().iterations++;
                }
                state.mut().gcd = locals.x;
                if (locals.x == 1)
                {
                    state.mut().coprimes++;
                }
            `,
            pairs: [
                [0n, 0n],
                [12n, 18n],
                [17n, 5n],
                [18446744073709551615n, 3n],
                [1000000007n, 998244353n],
                [8n, 8n],
            ],
        }),
    ),

    wideArchetype(
        {
            name: "WideRotateBothWays",
            family: "integers",
            solidity: "solady/LibBit.sol (rotl/rotr)",
            stresses:
                "rotate left and right built from two shifts and an OR, at counts 0, 1, 63 and 64 — where the naive spelling shifts by the full width and is undefined",
            caveat: "Solidity has no rotate either; the library builds it from shifts exactly as this does, so the port is faithful apart from the width.",
        },
        () => ({
            state: "uint64 rotatedLeft;\nuint64 rotatedRight;\nuint64 roundTrips;\nuint64 zeroCountCases;",
            locals: "uint64 count;\nuint64 left;\nuint64 right;\nuint64 back;",
            output: "uint64 rotatedLeft;\nuint64 rotatedRight;\nuint64 roundTrips;\nuint64 zeroCountCases;",
            body: `
                locals.count = input.b & 63ULL;
                if (locals.count == 0)
                {
                    state.mut().zeroCountCases++;
                    locals.left = input.a;
                    locals.right = input.a;
                }
                else
                {
                    locals.left = (input.a << locals.count) | (input.a >> (64 - locals.count));
                    locals.right = (input.a >> locals.count) | (input.a << (64 - locals.count));
                }
                state.mut().rotatedLeft = locals.left;
                state.mut().rotatedRight = locals.right;
                // Rotating back must restore the input, which is the property the two shifts encode.
                if (locals.count == 0)
                {
                    locals.back = locals.left;
                }
                else
                {
                    locals.back = (locals.left >> locals.count) | (locals.left << (64 - locals.count));
                }
                if (locals.back == input.a)
                {
                    state.mut().roundTrips++;
                }
            `,
            pairs: [
                [1n, 0n],
                [1n, 1n],
                [1n, 63n],
                [1n, 64n],
                [18446744073709551615n, 32n],
                [9223372036854775808n, 1n],
            ],
        }),
    ),

    wideArchetype(
        {
            name: "WideCountLeadingZeros",
            family: "integers",
            solidity: `${OZ} (log2)`,
            stresses: "leading-zero count by binary search over the word, next to the shift-until-zero loop, with both results stored",
            caveat: "OpenZeppelin's log2 is over uint256; the port is the same ladder over 64 bits.",
        },
        () => ({
            state: "uint64 binarySearch;\nuint64 loopCount;\nuint64 disagreements;",
            locals: "uint64 value;\nuint64 zeros;\nuint64 shift;\nuint64 counted;",
            output: "uint64 binarySearch;\nuint64 loopCount;\nuint64 disagreements;",
            body: `
                locals.value = input.a;
                locals.zeros = 0;
                if (locals.value == 0)
                {
                    locals.zeros = 64;
                }
                else
                {
                    locals.shift = 32;
                    while (locals.shift > 0)
                    {
                        if ((locals.value >> (64 - locals.shift)) == 0)
                        {
                            locals.zeros += locals.shift;
                            locals.value = locals.value << locals.shift;
                        }
                        locals.shift = locals.shift >> 1;
                    }
                }
                state.mut().binarySearch = locals.zeros;

                locals.value = input.a;
                locals.counted = 0;
                while (locals.counted < 64 && (locals.value & 9223372036854775808ULL) == 0)
                {
                    locals.value = locals.value << 1;
                    locals.counted++;
                }
                state.mut().loopCount = locals.counted;
                if (locals.counted != locals.zeros)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [2n, 0n],
                [9223372036854775808n, 0n],
                [18446744073709551615n, 0n],
                [4294967296n, 0n],
            ],
            // binarySearch, loopCount, disagreements, calls — clz of each operand at 64 bits.
            expect: [
                { step: 1, values: [64n, 64n, 0n, 1n], note: "clz(0) = 64 by the archetype's own convention" },
                { step: 3, values: [63n, 63n, 0n, 2n], note: "clz(1) = 63" },
                { step: 5, values: [62n, 62n, 0n, 3n], note: "clz(2) = 62" },
                { step: 7, values: [0n, 0n, 0n, 4n], note: "clz(2^63) = 0" },
                { step: 9, values: [0n, 0n, 0n, 5n], note: "clz(2^64-1) = 0" },
                { step: 11, values: [31n, 31n, 0n, 6n], note: "clz(2^32) = 31" },
            ],
        }),
    ),

    wideArchetype(
        {
            name: "WidePopcountTwoWays",
            family: "integers",
            solidity: "solady/LibBit.sol (popCount)",
            stresses: "population count by Kernighan's loop and by the SWAR bit-twiddle, which must agree on every input",
            caveat: "The SWAR constants are the 64-bit ones; the Solidity original uses their 256-bit siblings.",
        },
        () => ({
            state: "uint64 kernighan;\nuint64 swar;\nuint64 disagreements;",
            locals: "uint64 value;\nuint64 count;\nuint64 x;",
            output: "uint64 kernighan;\nuint64 swar;\nuint64 disagreements;",
            body: `
                locals.value = input.a;
                locals.count = 0;
                while (locals.value != 0)
                {
                    locals.value = locals.value & (locals.value - 1);
                    locals.count++;
                }
                state.mut().kernighan = locals.count;

                locals.x = input.a;
                locals.x = locals.x - ((locals.x >> 1) & 6148914691236517205ULL);
                locals.x = (locals.x & 3689348814741910323ULL) + ((locals.x >> 2) & 3689348814741910323ULL);
                locals.x = (locals.x + (locals.x >> 4)) & 1085102592571150095ULL;
                locals.x = (locals.x * 72340172838076673ULL) >> 56;
                state.mut().swar = locals.x;
                if (locals.x != locals.count)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [18446744073709551615n, 0n],
                [6148914691236517205n, 0n],
                [9223372036854775808n, 0n],
                [255n, 0n],
            ],
            // kernighan, swar, disagreements, calls — the population count of each operand, which is a
            // property of the number and not of either compiler.
            expect: [
                { step: 1, values: [0n, 0n, 0n, 1n], note: "popcount(0) = 0" },
                { step: 3, values: [1n, 1n, 0n, 2n], note: "popcount(1) = 1" },
                { step: 5, values: [64n, 64n, 0n, 3n], note: "popcount(2^64-1) = 64" },
                { step: 7, values: [32n, 32n, 0n, 4n], note: "popcount(0x5555...) = 32" },
                { step: 9, values: [1n, 1n, 0n, 5n], note: "popcount(2^63) = 1" },
                { step: 11, values: [8n, 8n, 0n, 6n], note: "popcount(255) = 8" },
            ],
        }),
    ),

    wideArchetype(
        {
            name: "WideFixedPointMultiply",
            family: "integers",
            solidity: "abdk-libraries-solidity/ABDKMath64x64.sol (mul)",
            stresses:
                "Q32.32 fixed-point multiply with the rounding step written out — a shift right by 32 after a product that may already have lost the high half",
            caveat: "ABDK works in 64.64 over int128; the port is 32.32 over uint64, so the precision loss arrives sooner and is part of what is being compared.",
        },
        () => ({
            state: "uint64 productRounded;\nuint64 productTruncated;\nuint64 lostPrecision;",
            locals: "uint64 product;\nuint64 rounded;",
            output: "uint64 productRounded;\nuint64 productTruncated;\nuint64 lostPrecision;",
            body: `
                locals.product = (input.a >> 16) * (input.b >> 16);
                state.mut().productTruncated = locals.product >> 32;
                locals.rounded = (locals.product + 2147483648ULL) >> 32;
                state.mut().productRounded = locals.rounded;
                if (locals.rounded != (locals.product >> 32))
                {
                    state.mut().lostPrecision++;
                }
            `,
            pairs: EDGE_PAIRS,
        }),
    ),

    wideArchetype(
        {
            name: "WideSaturatingMultiply",
            family: "integers",
            solidity: `${OZ} (tryMul)`,
            stresses: "overflow-checked multiply: the product is computed, then divided back to see whether it wrapped, and clamped when it did",
            caveat: "OpenZeppelin returns a (bool, value) tuple; QPI has no tuples, so the port stores the flag and the clamped value.",
        },
        () => ({
            state: "uint64 clamped;\nuint64 raw;\nuint64 saturations;\nuint64 exact;",
            locals: "uint64 product;",
            output: "uint64 clamped;\nuint64 raw;\nuint64 saturations;\nuint64 exact;",
            body: `
                locals.product = input.a * input.b;
                state.mut().raw = locals.product;
                if (input.a != 0 && QPI::div(locals.product, input.a) != input.b)
                {
                    state.mut().clamped = 18446744073709551615ULL;
                    state.mut().saturations++;
                }
                else
                {
                    state.mut().clamped = locals.product;
                    state.mut().exact++;
                }
            `,
            pairs: EDGE_PAIRS,
        }),
    ),

    wideArchetype(
        {
            name: "WideDigitExtraction",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/Strings.sol (toString)",
            stresses: "repeated div/mod by ten to extract every digit, with the digit count and the reconstructed value compared against the input",
            caveat: "Strings.toString builds a string; QPI has no strings, so the port accumulates the digits into a checksum and rebuilds the number instead.",
        },
        () => ({
            state: "uint64 digits;\nuint64 checksum;\nuint64 rebuilt;\nuint64 roundTrips;",
            locals: "uint64 value;\nuint64 digit;\nuint64 scale;\nuint64 rebuilt;\nuint64 count;",
            output: "uint64 digits;\nuint64 checksum;\nuint64 rebuilt;\nuint64 roundTrips;",
            body: `
                locals.value = input.a;
                locals.count = 0;
                locals.scale = 1;
                locals.rebuilt = 0;
                if (locals.value == 0)
                {
                    locals.count = 1;
                }
                while (locals.value != 0 && locals.count < 20)
                {
                    locals.digit = QPI::mod(locals.value, 10ULL);
                    state.mut().checksum += locals.digit;
                    locals.rebuilt += locals.digit * locals.scale;
                    locals.scale = locals.scale * 10ULL;
                    locals.value = QPI::div(locals.value, 10ULL);
                    locals.count++;
                }
                state.mut().digits = locals.count;
                state.mut().rebuilt = locals.rebuilt;
                if (locals.rebuilt == input.a)
                {
                    state.mut().roundTrips++;
                }
            `,
            pairs: [
                [0n, 0n],
                [7n, 0n],
                [1000000007n, 0n],
                [18446744073709551615n, 0n],
                [10000000000000000000n, 0n],
                [999999999999999999n, 0n],
            ],
        }),
    ),

    wideArchetype(
        {
            name: "WideCarryChainAdd",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/Math.sol (add512)",
            stresses:
                "128-bit addition as two 64-bit lanes with an explicit carry, driven right at the lane boundary so the carry is exercised in both directions",
            caveat: "The Solidity original adds two 256-bit halves; this is the same carry chain one word narrower.",
        },
        () => ({
            state: "uint64 low;\nuint64 high;\nuint64 carries;\nuint64 wrapped;",
            locals: "uint64 sumLow;\nuint64 carry;",
            output: "uint64 low;\nuint64 high;\nuint64 carries;\nuint64 wrapped;",
            body: `
                locals.sumLow = state.get().low + input.a;
                locals.carry = locals.sumLow < state.get().low ? 1 : 0;
                state.mut().low = locals.sumLow;
                state.mut().high = state.get().high + input.b + locals.carry;
                if (locals.carry != 0)
                {
                    state.mut().carries++;
                }
                if (state.get().high < input.b)
                {
                    state.mut().wrapped++;
                }
            `,
            pairs: [
                [1n, 0n],
                [18446744073709551615n, 0n],
                [1n, 0n],
                [9223372036854775808n, 1n],
                [9223372036854775808n, 18446744073709551615n],
                [0n, 0n],
            ],
        }),
    ),

    wideArchetype(
        {
            name: "WideIsqrtBinarySearch",
            family: "integers",
            solidity: `${OZ} (sqrt)`,
            stresses:
                "integer square root by binary search over the bit positions, checked against squaring the answer — where an off-by-one in the bound leaves a result one too high",
            caveat: "OpenZeppelin's sqrt is Newton's method over uint256 with a seed from log2; the port is the bit-by-bit variant over 64 bits, chosen because it has no division at all.",
        },
        () => ({
            state: "uint64 root;\nuint64 remainder;\nuint64 exact;\nuint64 offByOne;",
            locals: "uint64 value;\nuint64 root;\nuint64 bit;\nuint64 trial;",
            output: "uint64 root;\nuint64 remainder;\nuint64 exact;\nuint64 offByOne;",
            body: `
                locals.value = input.a;
                locals.root = 0;
                locals.bit = 4611686018427387904ULL;
                while (locals.bit > locals.value)
                {
                    locals.bit = locals.bit >> 2;
                }
                while (locals.bit != 0)
                {
                    locals.trial = locals.root + locals.bit;
                    locals.root = locals.root >> 1;
                    if (locals.value >= locals.trial)
                    {
                        locals.value -= locals.trial;
                        locals.root += locals.bit;
                    }
                    locals.bit = locals.bit >> 2;
                }
                state.mut().root = locals.root;
                state.mut().remainder = locals.value;
                if (locals.root * locals.root == input.a)
                {
                    state.mut().exact++;
                }
                if ((locals.root + 1) * (locals.root + 1) <= input.a)
                {
                    state.mut().offByOne++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [15n, 0n],
                [16n, 0n],
                [1000000000000n, 0n],
                [18446744073709551615n, 0n],
            ],
        }),
    ),
];
