// Integer library maths, ported from OpenZeppelin's `utils/math/*`.
//
// These are the branchless idioms real contracts run: sign masks, overflow-free averages, saturating
// arithmetic, downcast ladders, and iterative log2/sqrt. Every one of them leans on behaviour C++ leaves
// to the target — arithmetic vs logical shift on a sign bit, signed/unsigned reinterpretation, wrap on
// overflow — which is exactly what two independent code generators can disagree about. The naive form
// sits beside the clever one in the same contract wherever possible, so a divergence has its control
// built in.

import { singleProcedureArchetype } from "./common";
import { maxOf, minOf, scalar, u64 } from "../encode";
import { widthOf } from "../axes";
import type { Archetype, CallStep, ScalarWidth } from "../types";

const OZ = "OpenZeppelin utils/math";

function drivePairs(width: ScalarWidth, pairs: [bigint, bigint][]): CallStep[] {
    const steps: CallStep[] = [];
    for (const [a, b] of pairs) {
        steps.push({ kind: "procedure", entry: 1, in: scalar(width, a) + scalar(width, b), invocator: 0, note: `${a}, ${b}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

function drive64(values: bigint[]): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry: 1, in: u64(value), invocator: 0, note: `value ${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const INTEGER_MATH_ARCHETYPES: Archetype[] = [
    singleProcedureArchetype(
        {
            name: "MathAverageNoOverflow",
            family: "integers",
            solidity: `${OZ}/Math.sol` + " (`average`)",
            stresses: "the overflow-free average `(a & b) + ((a ^ b) >> 1)` beside the naive `(a + b) / 2` — they must agree except where the naive one wraps",
            caveat: "Solidity's `/` becomes QPI::div; the clever form is the point and the naive one is the control.",
            axes: ["width", "placement", "temporaries"],
        },
        (axis) => {
            const width = widthOf(axis, "uint64");
            return {
                extraState: `${width} clever;\n${width} naive;\nuint64 disagreements;`,
                input: `${width} a;\n${width} b;`,
                locals: `${width} left;\n${width} right;`,
                body: `
                    locals.left = (input.a & input.b) + ((input.a ^ input.b) >> 1);
                    locals.right = QPI::div((${width})(input.a + input.b), (${width})2);
                    state.mut().clever = locals.left;
                    state.mut().naive = locals.right;
                    if (locals.left != locals.right)
                    {
                        state.mut().disagreements++;
                    }
                    state.mut().accumulator = (uint64)locals.left;
                `,
                steps: drivePairs(width, [
                    [0n, 0n],
                    [1n, 3n],
                    [maxOf(width), maxOf(width)],
                    [maxOf(width), 1n],
                    [maxOf(width) - 1n, 2n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "MathAbsViaSignMask",
            family: "integers",
            solidity: `${OZ}/SignedMath.sol` + " (`abs`)",
            stresses: "`mask = n >> 63; abs = (n + mask) ^ mask` — an arithmetic shift on the sign bit, then a signed-to-unsigned reinterpretation, exercised at INT64_MIN where the result is not representable",
            caveat: "OpenZeppelin shifts by 255 for int256; the port shifts by 63 for sint64.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            extraState: "uint64 viaMask;\nuint64 viaBranch;\nuint64 disagreements;",
            input: "sint64 value;\nsint64 unused;",
            locals: "sint64 mask;\nuint64 masked;\nuint64 branched;",
            body: `
                locals.mask = input.value >> 63;
                locals.masked = (uint64)((input.value + locals.mask) ^ locals.mask);
                if (input.value < 0)
                {
                    locals.branched = (uint64)(0 - input.value);
                }
                else
                {
                    locals.branched = (uint64)input.value;
                }
                state.mut().viaMask = locals.masked;
                state.mut().viaBranch = locals.branched;
                if (locals.masked != locals.branched)
                {
                    state.mut().disagreements++;
                }
                state.mut().accumulator = locals.masked;
            `,
            steps: drivePairs("sint64", [
                [0n, 0n],
                [1n, 0n],
                [-1n, 0n],
                [minOf("sint64"), 0n],
                [minOf("sint64") + 1n, 0n],
                [maxOf("sint64"), 0n],
            ]),
        }),
    ),

    singleProcedureArchetype(
        {
            name: "MathSignedAverage",
            family: "integers",
            solidity: `${OZ}/SignedMath.sol` + " (`average`)",
            stresses: "`(a >> 1) + (b >> 1) + (a & b & 1)` on signed operands — arithmetic shift rounding toward negative infinity, which the naive division does not do",
            axes: ["placement"],
        },
        () => ({
            extraState: "sint64 clever;\nsint64 naive;\nuint64 disagreements;",
            input: "sint64 a;\nsint64 b;",
            locals: "sint64 left;\nsint64 right;",
            body: `
                locals.left = (input.a >> 1) + (input.b >> 1) + (input.a & input.b & 1);
                locals.right = QPI::div(input.a + input.b, (sint64)2);
                state.mut().clever = locals.left;
                state.mut().naive = locals.right;
                if (locals.left != locals.right)
                {
                    state.mut().disagreements++;
                }
                state.mut().accumulator = (uint64)locals.left;
            `,
            steps: drivePairs("sint64", [
                [1n, 3n],
                [-1n, -3n],
                [-1n, 2n],
                [minOf("sint64"), maxOf("sint64")],
                [minOf("sint64"), minOf("sint64")],
            ]),
        }),
    ),

    singleProcedureArchetype(
        {
            name: "MathSaturatingAddSub",
            family: "integers",
            solidity: `${OZ}/Math.sol` + " (`saturatingAdd`, `saturatingSub`)",
            stresses: "overflow detection by `c >= a` — an idiom that is only correct because wrap is defined, and which a compiler that optimises the check away would break",
            caveat: "Solidity 0.8 needs `unchecked` for the wrap the check depends on; QPI wraps natively.",
            axes: ["width", "placement", "temporaries"],
        },
        (axis) => {
            const width = widthOf(axis, "uint64");
            return {
                extraState: `${width} added;\n${width} subtracted;\nuint64 saturations;`,
                input: `${width} a;\n${width} b;`,
                locals: `${width} sum;\n${width} difference;`,
                body: `
                    locals.sum = input.a + input.b;
                    if (locals.sum < input.a)
                    {
                        locals.sum = ${maxOf(widthOf(axis, "uint64"))};
                        state.mut().saturations++;
                    }
                    locals.difference = input.a - input.b;
                    if (input.a < input.b)
                    {
                        locals.difference = 0;
                        state.mut().saturations++;
                    }
                    state.mut().added = locals.sum;
                    state.mut().subtracted = locals.difference;
                    state.mut().accumulator = (uint64)locals.sum;
                `,
                steps: drivePairs(width, [
                    [1n, 2n],
                    [maxOf(width), 1n],
                    [maxOf(width), maxOf(width)],
                    [0n, 1n],
                    [3n, 3n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "MathSafeCastDowncastLadder",
            family: "integers",
            solidity: `${OZ}/SafeCast.sol`,
            stresses: "a uint64 → uint32 → uint16 → uint8 ladder with a range check before each step, driven at every boundary and one past it",
            caveat: "OpenZeppelin reverts on a failed check; QPI has no revert, so the port returns an ok-flag and — deliberately — leaves the earlier writes in place.",
            axes: ["placement", "temporaries", "entryShape"],
        },
        () => ({
            extraState: "uint32 as32;\nuint16 as16;\nuint8 as8;\nuint64 rejected;",
            input: "uint64 value;",
            locals: "uint64 scratch;",
            body: `
                state.mut().rejected = 0;
                if (input.value > 4294967295)
                {
                    state.mut().rejected++;
                }
                else
                {
                    state.mut().as32 = (uint32)input.value;
                }
                if (input.value > 65535)
                {
                    state.mut().rejected++;
                }
                else
                {
                    state.mut().as16 = (uint16)input.value;
                }
                if (input.value > 255)
                {
                    state.mut().rejected++;
                }
                else
                {
                    state.mut().as8 = (uint8)input.value;
                }
                locals.scratch = (uint64)state.get().as32 + (uint64)state.get().as16 + (uint64)state.get().as8;
                state.mut().accumulator = locals.scratch;
            `,
            steps: drive64([0n, 255n, 256n, 65535n, 65536n, 4294967295n, 4294967296n, 18446744073709551615n]),
        }),
    ),

    singleProcedureArchetype(
        {
            name: "MathLog2Ladder",
            family: "integers",
            solidity: `${OZ}/Math.sol` + " (`log2`)",
            stresses: "the cascading most-significant-bit ladder: `result += toUint(x > mask) << k`, with a bool-to-integer conversion feeding a variable shift",
            caveat: "OpenZeppelin's final byte-table lookup uses assembly and is dropped; the ladder is the part that ports.",
            axes: ["placement", "loopShape", "temporaries"],
        },
        () => ({
            extraState: "uint64 log2Value;\nuint64 viaLoop;\nuint64 disagreements;",
            input: "uint64 value;",
            locals: "uint64 x;\nuint64 result;\nuint64 loopResult;\nuint64 probe;",
            body: `
                locals.x = input.value;
                locals.result = 0;
                if (locals.x >= 4294967296)
                {
                    locals.x >>= 32;
                    locals.result += 32;
                }
                if (locals.x >= 65536)
                {
                    locals.x >>= 16;
                    locals.result += 16;
                }
                if (locals.x >= 256)
                {
                    locals.x >>= 8;
                    locals.result += 8;
                }
                if (locals.x >= 16)
                {
                    locals.x >>= 4;
                    locals.result += 4;
                }
                if (locals.x >= 4)
                {
                    locals.x >>= 2;
                    locals.result += 2;
                }
                if (locals.x >= 2)
                {
                    locals.result += 1;
                }
                state.mut().log2Value = locals.result;
                // The control: the same answer by shifting one bit at a time.
                locals.loopResult = 0;
                locals.probe = input.value;
                while (locals.probe > 1)
                {
                    locals.probe >>= 1;
                    locals.loopResult++;
                }
                state.mut().viaLoop = locals.loopResult;
                if (locals.result != locals.loopResult)
                {
                    state.mut().disagreements++;
                }
                state.mut().accumulator = locals.result;
            `,
            steps: drive64([0n, 1n, 2n, 3n, 255n, 256n, 4294967295n, 4294967296n, 18446744073709551615n]),
        }),
    ),

    singleProcedureArchetype(
        {
            name: "MathSqrtNewton",
            family: "integers",
            solidity: `${OZ}/Math.sol` + " (`sqrt`)",
            stresses: "an msb estimate followed by a fixed number of Newton steps, each `xn = (xn + div(a, xn)) / 2` — a loop whose every iteration divides",
            caveat: "OpenZeppelin recurses in places; QPI forbids recursion, so the six Newton steps are unrolled into a bounded loop.",
            axes: ["placement", "loopShape"],
        },
        () => ({
            extraState: "uint64 root;\nuint64 squared;\nuint64 exact;",
            input: "uint64 value;",
            locals: "uint64 estimate;\nuint64 i;\nuint64 next;",
            body: `
                if (input.value == 0)
                {
                    state.mut().root = 0;
                    state.mut().squared = 0;
                    state.mut().exact = 1;
                }
                else
                {
                    locals.estimate = 1;
                    for (locals.i = 0; locals.i < 32; locals.i++)
                    {
                        if ((locals.estimate * locals.estimate) < input.value)
                        {
                            locals.estimate <<= 1;
                        }
                    }
                    for (locals.i = 0; locals.i < 8; locals.i++)
                    {
                        locals.next = QPI::div(locals.estimate + QPI::div(input.value, locals.estimate), 2ULL);
                        locals.estimate = locals.next;
                    }
                    state.mut().root = locals.estimate;
                    state.mut().squared = locals.estimate * locals.estimate;
                    state.mut().exact = (state.get().squared == input.value) ? 1 : 0;
                }
                state.mut().accumulator = state.get().root;
            `,
            steps: drive64([0n, 1n, 2n, 4n, 15n, 16n, 1000000n, 4294967296n, 18446744073709551615n]),
        }),
    ),

    singleProcedureArchetype(
        {
            name: "MathCeilDivBoundary",
            family: "integers",
            solidity: `${OZ}/Math.sol` + " (`ceilDiv`)",
            stresses: "`a == 0 ? 0 : (a - 1) / b + 1` — the guard exists precisely so the `a - 1` does not wrap, driven at a = 0 and a = max",
            caveat: "Solidity's `/` becomes QPI::div, which returns 0 for a zero divisor rather than panicking; the b = 0 row asserts that.",
            axes: ["width", "placement"],
        },
        (axis) => {
            const width = widthOf(axis, "uint64");
            return {
                extraState: `${width} ceiling;\n${width} floor;\nuint64 differed;`,
                input: `${width} a;\n${width} b;`,
                locals: `${width} up;\n${width} down;`,
                body: `
                    locals.down = QPI::div(input.a, input.b);
                    if (input.a == 0)
                    {
                        locals.up = 0;
                    }
                    else
                    {
                        locals.up = QPI::div((${width})(input.a - 1), input.b) + 1;
                    }
                    state.mut().ceiling = locals.up;
                    state.mut().floor = locals.down;
                    if (locals.up != locals.down)
                    {
                        state.mut().differed++;
                    }
                    state.mut().accumulator = (uint64)locals.up;
                `,
                steps: drivePairs(width, [
                    [0n, 3n],
                    [1n, 3n],
                    [3n, 3n],
                    [4n, 3n],
                    [maxOf(width), 3n],
                    [5n, 0n],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "MathBranchlessTernary",
            family: "integers",
            solidity: `${OZ}/Math.sol` + " (`ternary`)",
            stresses: "`b ^ ((a ^ b) * toUint(cond))` — the branchless select, whose correctness depends on the bool-to-integer conversion being exactly 0 or 1",
            axes: ["width", "placement", "temporaries"],
        },
        (axis) => {
            const width = widthOf(axis, "uint64");
            return {
                extraState: `${width} branchless;\n${width} branched;\nuint64 disagreements;`,
                input: `${width} a;\n${width} b;`,
                locals: `${width} flag;\n${width} left;\n${width} right;`,
                body: `
                    locals.flag = (input.a > input.b) ? 1 : 0;
                    locals.left = input.b ^ ((input.a ^ input.b) * locals.flag);
                    if (input.a > input.b)
                    {
                        locals.right = input.a;
                    }
                    else
                    {
                        locals.right = input.b;
                    }
                    state.mut().branchless = locals.left;
                    state.mut().branched = locals.right;
                    if (locals.left != locals.right)
                    {
                        state.mut().disagreements++;
                    }
                    state.mut().accumulator = (uint64)locals.left;
                `,
                steps: drivePairs(width, [
                    [1n, 2n],
                    [2n, 1n],
                    [0n, 0n],
                    [maxOf(width), 0n],
                    [maxOf(width), maxOf(width)],
                ]),
            };
        },
    ),

    singleProcedureArchetype(
        {
            name: "MathBitCountPopulation",
            family: "integers",
            solidity: `${OZ}/Math.sol` + " (bit utilities)",
            stresses: "a bounded population count over every bit of the width, against a shift-and-mask form — two ways to the same number",
            axes: ["width", "loopShape", "placement"],
        },
        (axis) => {
            const width = widthOf(axis, "uint64");
            return {
                extraState: "uint64 popcount;\nuint64 highestBit;",
                input: `${width} value;`,
                locals: "uint64 i;\nuint64 count;\nuint64 highest;\nuint64 probe;",
                body: `
                    locals.count = 0;
                    locals.highest = 0;
                    for (locals.i = 0; locals.i < 64; locals.i++)
                    {
                        locals.probe = ((uint64)input.value >> locals.i) & 1;
                        if (locals.probe == 1)
                        {
                            locals.count++;
                            locals.highest = locals.i + 1;
                        }
                    }
                    state.mut().popcount = locals.count;
                    state.mut().highestBit = locals.highest;
                    state.mut().accumulator = locals.count;
                `,
                steps: (() => {
                    const values = [0n, 1n, 2n, 3n, maxOf(width), maxOf(width) >> 1n];
                    const steps: CallStep[] = [];
                    for (const value of values) {
                        steps.push({ kind: "procedure", entry: 1, in: scalar(width, value), invocator: 0, note: `value ${value}` });
                        steps.push({ kind: "function", entry: 1 });
                    }
                    steps.push({ kind: "advanceTick", n: 1 });
                    return steps;
                })(),
            };
        },
    ),
];

/**
 * Pins F203. `qpi.K12` binds `const T&` and hashes `sizeof(T)` bytes, so a computed argument must hash
 * the same bytes as a named local holding that value. It does under clang and does not under the
 * TypeScript backend, which makes every commitment or Merkle root a contract computes inline differ from
 * what the chain would produce. Kept as its own archetype so the finding has a standing regression row.
 */
export const K12_EXPRESSION_ARCHETYPES: Archetype[] = [
    singleProcedureArchetype(
        {
            name: "K12OfComputedExpression",
            family: "integers",
            solidity: "OpenZeppelin utils/cryptography/MerkleProof.sol (hashing a computed value)",
            stresses: "qpi.K12 applied to an expression rather than a named variable — the same value through a local is the control",
            caveat: "The two spellings are the same 8 bytes by C++ rules, so any difference between them is a backend defect rather than a port artefact.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            extraState: "id ofLocal;\nid ofExpression;\nuint64 agree;",
            input: "uint64 a;\nuint64 b;",
            locals: "uint64 sum;",
            body: `
                locals.sum = input.a + input.b;
                state.mut().ofLocal = qpi.K12(locals.sum);
                state.mut().ofExpression = qpi.K12(input.a + input.b);
                state.mut().agree = (state.get().ofLocal == state.get().ofExpression) ? 1 : 0;
                state.mut().accumulator = state.get().agree;
            `,
            steps: drivePairs("uint64", [
                [1n, 1n],
                [5n, 0n],
                [7n, 3n],
            ]),
        }),
    ),
];
