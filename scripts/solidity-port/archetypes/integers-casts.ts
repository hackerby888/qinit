// Casts, promotions and comparisons — the rules C++ applies before an operator ever runs.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

const SOL = "test/libsolidity/semanticTests";

const WIDE_PAIRS: [bigint, bigint][] = [
    [0n, 0n],
    [255n, 1n],
    [256n, 1n],
    [65535n, 1n],
    [4294967295n, 1n],
    [18446744073709551615n, 1n],
];

export const INTEGER_CAST_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "CastDownAndBackUp",
            family: "integers",
            solidity: `${SOL}/cleanup/cleanup_in_compound_assign.sol`,
            stresses: "a value narrowed to 8, 16 and 32 bits and widened straight back, so each round trip records exactly how much was lost",
        },
        () => ({
            state: "uint64 viaByte;\nuint64 viaWord;\nuint64 viaDouble;\nuint64 lossyCount;",
            locals: "uint8 asByte;\nuint16 asWord;\nuint32 asDouble;",
            body: `
                locals.asByte = (uint8)input.a;
                locals.asWord = (uint16)input.a;
                locals.asDouble = (uint32)input.a;
                state.mut().viaByte = (uint64)locals.asByte;
                state.mut().viaWord = (uint64)locals.asWord;
                state.mut().viaDouble = (uint64)locals.asDouble;
                if (state.get().viaByte != input.a)
                {
                    state.mut().lossyCount++;
                }
            `,
            pairs: WIDE_PAIRS,
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 0n], note: "0 survives every narrowing" },
                { pair: 1, values: [255n, 255n, 255n, 0n], note: "255 fits in a byte" },
                { pair: 2, values: [0n, 256n, 256n, 1n], note: "256 truncates to 0 at eight bits" },
                { pair: 3, values: [255n, 65535n, 65535n, 2n], note: "65535 keeps its low byte" },
                { pair: 4, values: [255n, 65535n, 4294967295n, 3n], note: "2^32-1 survives only the 32-bit lane" },
                { pair: 5, values: [255n, 65535n, 4294967295n, 4n], note: "2^64-1 truncates in all three" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SignedNarrowingKeepsSignBit",
            family: "integers",
            solidity: `${SOL}/cleanup/cleanup_bytes_types.sol`,
            stresses:
                "a value narrowed into sint8 and sint16 and widened back to sint64, where the sign bit of the narrow type decides whether the result comes back negative",
        },
        () => ({
            state: "sint64 fromByte;\nsint64 fromWord;\nuint64 negativeCount;",
            locals: "sint8 asByte;\nsint16 asWord;",
            body: `
                locals.asByte = (sint8)input.a;
                locals.asWord = (sint16)input.a;
                state.mut().fromByte = (sint64)locals.asByte;
                state.mut().fromWord = (sint64)locals.asWord;
                if (state.get().fromByte < 0)
                {
                    state.mut().negativeCount++;
                }
            `,
            pairs: [
                [0n, 0n],
                [127n, 0n],
                [128n, 0n],
                [255n, 0n],
                [32768n, 0n],
                [65535n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n], note: "0 stays 0" },
                { pair: 1, values: [127n, 127n, 0n], note: "127 is the largest positive sint8" },
                { pair: 2, values: [-128n, 128n, 1n], note: "128 read as sint8 is -128" },
                { pair: 3, values: [-1n, 255n, 2n], note: "255 read as sint8 is -1" },
                { pair: 4, values: [0n, -32768n, 2n], note: "32768 read as sint16 is -32768, low byte is 0" },
                { pair: 5, values: [-1n, -1n, 3n], note: "65535 is -1 at both widths" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "PromotionBeforeComparison",
            family: "integers",
            solidity: `${SOL}/types/mixed_signed_unsigned_comparison.sol`,
            stresses:
                "a narrow signed value compared against a wide unsigned one, where the promotion decides whether -1 is less than 1 or larger than everything",
            caveat: "Solidity rejects a signed/unsigned comparison at compile time; C++ converts and compares, so the port records what the conversion produced.",
        },
        () => ({
            state: "uint64 signedLess;\nuint64 unsignedLess;\nuint64 promotedEqual;\nuint64 disagreements;",
            locals: "sint8 narrow;\nuint64 wide;\nuint64 asUnsigned;",
            body: `
                locals.narrow = (sint8)input.a;
                locals.wide = input.b;
                state.mut().signedLess = (sint64)locals.narrow < (sint64)locals.wide ? 1 : 0;
                locals.asUnsigned = (uint64)locals.narrow;
                state.mut().unsignedLess = locals.asUnsigned < locals.wide ? 1 : 0;
                state.mut().promotedEqual = (sint64)locals.narrow == (sint64)locals.wide ? 1 : 0;
                if (state.get().signedLess != state.get().unsignedLess)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [0n, 0n],
                [255n, 1n],
                [1n, 1n],
                [127n, 128n],
                [128n, 0n],
                [255n, 18446744073709551615n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 1n, 0n], note: "0 < 0 is false, 0 == 0 is true" },
                { pair: 1, values: [1n, 0n, 0n, 1n], note: "-1 < 1 signed, but 2^64-1 > 1 unsigned" },
                { pair: 2, values: [0n, 0n, 1n, 1n], note: "1 == 1 either way" },
                { pair: 3, values: [1n, 1n, 0n, 1n], note: "127 < 128 both ways" },
                { pair: 4, values: [1n, 0n, 0n, 2n], note: "-128 < 0 signed; as unsigned it is 2^64-128 and not less" },
                { pair: 5, values: [0n, 0n, 1n, 2n], note: "both sides read as -1, so equal and neither is less" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "CompoundAssignNarrowsEachStep",
            family: "integers",
            solidity: `${SOL}/cleanup/cleanup_in_compound_assign.sol`,
            stresses:
                "`x += y` on a uint8 member, repeated, where the narrowing happens on every assignment rather than once at the end — the Solidity test's own subject",
        },
        () => ({
            state: "uint64 narrowResult;\nuint64 wideResult;\nuint64 wrapCount;",
            locals: "uint8 narrow;\nuint64 wide;\nuint64 i;",
            body: `
                locals.narrow = 0;
                locals.wide = 0;
                for (locals.i = 0; locals.i < 4; locals.i++)
                {
                    locals.narrow += (uint8)input.a;
                    locals.wide += input.a;
                }
                state.mut().narrowResult = (uint64)locals.narrow;
                state.mut().wideResult = locals.wide;
                if (state.get().narrowResult != QPI::mod(state.get().wideResult, 256ULL))
                {
                    state.mut().wrapCount++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [64n, 0n],
                [100n, 0n],
                [255n, 0n],
                [256n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n], note: "four additions of zero" },
                { pair: 1, values: [4n, 4n, 0n], note: "1 four times" },
                { pair: 2, values: [0n, 256n, 0n], note: "64*4 = 256 wraps the byte to 0" },
                { pair: 3, values: [144n, 400n, 0n], note: "400 mod 256 = 144" },
                { pair: 4, values: [252n, 1020n, 0n], note: "1020 mod 256 = 252" },
                { pair: 5, values: [0n, 1024n, 0n], note: "256 truncates to 0 before the first add" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "TruncateThenDivide",
            family: "integers",
            solidity: `${SOL}/cleanup/cleanup_in_div.sol`,
            stresses:
                "a division whose operands are truncated first, next to the same division at full width — the case where narrowing turns a divisor into zero",
        },
        () => ({
            state: "uint64 narrowQuotient;\nuint64 wideQuotient;\nuint64 zeroDivisors;",
            locals: "uint8 lhs;\nuint8 rhs;",
            body: `
                locals.lhs = (uint8)input.a;
                locals.rhs = (uint8)input.b;
                state.mut().narrowQuotient = QPI::div((uint64)locals.lhs, (uint64)locals.rhs);
                state.mut().wideQuotient = QPI::div(input.a, input.b);
                if (locals.rhs == 0 && input.b != 0)
                {
                    state.mut().zeroDivisors++;
                }
            `,
            pairs: [
                [100n, 7n],
                [1000n, 256n],
                [512n, 2n],
                [255n, 255n],
                [0n, 0n],
                [65535n, 257n],
            ],
            expect: [
                { pair: 0, values: [14n, 14n, 0n], note: "100/7 = 14 at both widths" },
                { pair: 1, values: [0n, 3n, 1n], note: "256 truncates to a zero divisor; QPI::div returns 0" },
                { pair: 2, values: [0n, 256n, 1n], note: "512 truncates to 0; the counter still carries pair 1" },
                { pair: 3, values: [1n, 1n, 1n], note: "255/255 = 1" },
                { pair: 4, values: [0n, 0n, 1n], note: "a zero divisor that was already zero before truncation does not count" },
                { pair: 5, values: [255n, 255n, 1n], note: "257 truncates to 1 and 65535 to 255; 65535 = 255 * 257 exactly" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "BooleanToIntegerConversions",
            family: "integers",
            solidity: `${SOL}/types/bool_conversion.sol`,
            stresses: "comparison results used as arithmetic — the value of `true` in a sum, and the sum of several comparisons in one expression",
        },
        () => ({
            state: "uint64 asNumber;\nuint64 sumOfFlags;\nuint64 productOfFlags;",
            locals: "uint64 first;\nuint64 second;",
            body: `
                locals.first = input.a > input.b ? 1 : 0;
                locals.second = input.a == input.b ? 1 : 0;
                state.mut().asNumber = locals.first;
                state.mut().sumOfFlags = locals.first + locals.second + (input.a < input.b ? 1 : 0);
                state.mut().productOfFlags = locals.first * 10 + locals.second;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [0n, 1n],
                [5n, 5n],
                [18446744073709551615n, 0n],
                [0n, 18446744073709551615n],
            ],
            expect: [
                { pair: 0, values: [0n, 1n, 1n], note: "equal: exactly one of the three comparisons holds" },
                { pair: 1, values: [1n, 1n, 10n], note: "greater" },
                { pair: 2, values: [0n, 1n, 0n], note: "less" },
                { pair: 3, values: [0n, 1n, 1n], note: "equal again" },
                { pair: 4, values: [1n, 1n, 10n], note: "max > 0" },
                { pair: 5, values: [0n, 1n, 0n], note: "0 < max" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ExplicitCastChainThroughSigned",
            family: "integers",
            solidity: `${SOL}/conversions/explicit_conversion_chain.sol`,
            stresses:
                "uint64 to sint32 to uint16 to sint64 — a chain where each hop can change the sign and the width, and only the final value tells whether every hop was applied",
        },
        () => ({
            state: "sint64 chained;\nsint64 direct;\nuint64 differences;",
            locals: "sint32 asSigned;\nuint16 asWord;",
            body: `
                locals.asSigned = (sint32)input.a;
                locals.asWord = (uint16)locals.asSigned;
                state.mut().chained = (sint64)locals.asWord;
                state.mut().direct = (sint64)(uint16)input.a;
                if (state.get().chained != state.get().direct)
                {
                    state.mut().differences++;
                }
            `,
            pairs: [
                [0n, 0n],
                [65535n, 0n],
                [65536n, 0n],
                [4294967295n, 0n],
                [2147483648n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n], note: "zero through every hop" },
                { pair: 1, values: [65535n, 65535n, 0n], note: "the chain and the direct cast agree" },
                { pair: 2, values: [0n, 0n, 0n], note: "65536 loses its only set bit at 16 bits" },
                { pair: 3, values: [65535n, 65535n, 0n], note: "the low word survives" },
                { pair: 4, values: [0n, 0n, 0n], note: "2^31 has a zero low word" },
                { pair: 5, values: [65535n, 65535n, 0n], note: "all ones" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "NegationOfUnsignedWidths",
            family: "integers",
            solidity: `${SOL}/types/negative_literal_unsigned.sol`,
            stresses: "unary minus applied to unsigned values at three widths — the wrap that Solidity forbids and C++ defines, recorded at each width",
        },
        () => ({
            state: "uint64 negatedByte;\nuint64 negatedWord;\nuint64 negatedWide;",
            locals: "uint8 asByte;\nuint16 asWord;",
            body: `
                locals.asByte = (uint8)input.a;
                locals.asWord = (uint16)input.a;
                state.mut().negatedByte = (uint64)(uint8)(0 - locals.asByte);
                state.mut().negatedWord = (uint64)(uint16)(0 - locals.asWord);
                state.mut().negatedWide = 0 - input.a;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [128n, 0n],
                [255n, 0n],
                [256n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n], note: "negating zero" },
                { pair: 1, values: [255n, 65535n, 18446744073709551615n], note: "-1 at three widths" },
                { pair: 2, values: [128n, 65408n, 18446744073709551488n], note: "128 negates to itself at eight bits" },
                { pair: 3, values: [1n, 65281n, 18446744073709551361n], note: "255 negates to 1 at eight bits" },
                { pair: 4, values: [0n, 65280n, 18446744073709551360n], note: "256 truncates to 0 before negation" },
                { pair: 5, values: [1n, 1n, 1n], note: "negating all-ones gives 1 at every width" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ModuloSignsAcrossWidths",
            family: "integers",
            solidity: `${SOL}/expressions/module_signed.sol`,
            stresses:
                "QPI::mod over signed operands at 32 and 64 bits, where C++ truncates toward zero and the remainder therefore takes the sign of the dividend",
        },
        () => ({
            state: "sint64 wide;\nsint64 narrow;\nuint64 negativeRemainders;",
            locals: "sint32 lhs;\nsint32 rhs;",
            body: `
                locals.lhs = (sint32)input.a;
                locals.rhs = (sint32)input.b;
                state.mut().wide = QPI::mod((sint64)input.a, (sint64)input.b);
                state.mut().narrow = (sint64)QPI::mod(locals.lhs, locals.rhs);
                if (state.get().narrow < 0)
                {
                    state.mut().negativeRemainders++;
                }
            `,
            pairs: [
                [7n, 3n],
                [-7n, 3n],
                [7n, -3n],
                [-7n, -3n],
                [0n, 5n],
                [5n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 1n, 0n], note: "7 mod 3 = 1" },
                { pair: 1, values: [-1n, -1n, 1n], note: "the remainder takes the dividend's sign" },
                { pair: 2, values: [1n, 1n, 1n], note: "the divisor's sign does not reach the remainder" },
                { pair: 3, values: [-1n, -1n, 2n], note: "both negative" },
                { pair: 4, values: [0n, 0n, 2n], note: "zero dividend" },
                { pair: 5, values: [0n, 0n, 2n], note: "QPI::mod guards a zero divisor and returns 0" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "MinMaxWithoutBranches",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/Math.sol (min, max)",
            stresses: "branchless min and max built from a comparison and a multiply, checked against the branching spelling on the same operands",
        },
        () => ({
            state: "uint64 minBranchless;\nuint64 maxBranchless;\nuint64 minBranching;\nuint64 disagreements;",
            locals: "uint64 flag;",
            body: `
                locals.flag = input.a < input.b ? 1 : 0;
                state.mut().minBranchless = locals.flag * input.a + (1 - locals.flag) * input.b;
                state.mut().maxBranchless = locals.flag * input.b + (1 - locals.flag) * input.a;
                if (input.a < input.b)
                {
                    state.mut().minBranching = input.a;
                }
                else
                {
                    state.mut().minBranching = input.b;
                }
                if (state.get().minBranchless != state.get().minBranching)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 2n],
                [2n, 1n],
                [18446744073709551615n, 0n],
                [0n, 18446744073709551615n],
                [7n, 7n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 0n], note: "both zero" },
                { pair: 1, values: [1n, 2n, 1n, 0n], note: "a is smaller" },
                { pair: 2, values: [1n, 2n, 1n, 0n], note: "b is smaller" },
                { pair: 3, values: [0n, 18446744073709551615n, 0n, 0n], note: "max against zero" },
                { pair: 4, values: [0n, 18446744073709551615n, 0n, 0n], note: "and the other way round" },
                { pair: 5, values: [7n, 7n, 7n, 0n], note: "equal operands" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ClampToRange",
            family: "integers",
            solidity: "openzeppelin-contracts/contracts/utils/math/SafeCast.sol",
            stresses:
                "clamping into a byte range three ways — a pair of ifs, a pair of ternaries and a saturating cast — which must agree on every input including the boundaries",
        },
        () => ({
            state: "uint64 viaIfs;\nuint64 viaTernary;\nuint64 viaCast;\nuint64 disagreements;",
            locals: "uint64 value;",
            body: `
                locals.value = input.a;
                if (locals.value < 10)
                {
                    state.mut().viaIfs = 10;
                }
                else if (locals.value > 200)
                {
                    state.mut().viaIfs = 200;
                }
                else
                {
                    state.mut().viaIfs = locals.value;
                }
                state.mut().viaTernary = locals.value < 10 ? 10 : (locals.value > 200 ? 200 : locals.value);
                state.mut().viaCast = locals.value > 255 ? 255 : (uint64)(uint8)locals.value;
                if (state.get().viaIfs != state.get().viaTernary)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [0n, 0n],
                [10n, 0n],
                [100n, 0n],
                [200n, 0n],
                [255n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [10n, 10n, 0n, 0n], note: "below the floor" },
                { pair: 1, values: [10n, 10n, 10n, 0n], note: "on the floor" },
                { pair: 2, values: [100n, 100n, 100n, 0n], note: "inside" },
                { pair: 3, values: [200n, 200n, 200n, 0n], note: "on the ceiling" },
                { pair: 4, values: [200n, 200n, 255n, 0n], note: "above the ceiling but inside a byte" },
                { pair: 5, values: [200n, 200n, 255n, 0n], note: "far above" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "BitwiseOnNarrowedOperands",
            family: "integers",
            solidity: `${SOL}/various/bit_operations.sol`,
            stresses: "and, or, xor and not applied after truncation to eight bits, with the complement stored at both widths so the promotion is visible",
        },
        () => ({
            state: "uint64 andValue;\nuint64 orValue;\nuint64 xorValue;\nuint64 notNarrow;\nuint64 notWide;",
            locals: "uint8 lhs;\nuint8 rhs;",
            body: `
                locals.lhs = (uint8)input.a;
                locals.rhs = (uint8)input.b;
                state.mut().andValue = (uint64)(uint8)(locals.lhs & locals.rhs);
                state.mut().orValue = (uint64)(uint8)(locals.lhs | locals.rhs);
                state.mut().xorValue = (uint64)(uint8)(locals.lhs ^ locals.rhs);
                state.mut().notNarrow = (uint64)(uint8)(~locals.lhs);
                state.mut().notWide = ~input.a;
            `,
            pairs: [
                [0n, 0n],
                [255n, 15n],
                [170n, 85n],
                [256n, 1n],
                [65535n, 255n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n, 0n, 255n, 18446744073709551615n], note: "complement of zero" },
                { pair: 1, values: [15n, 255n, 240n, 0n, 18446744073709551360n], note: "0xFF and 0x0F" },
                { pair: 2, values: [0n, 255n, 255n, 85n, 18446744073709551445n], note: "0xAA and 0x55 are disjoint" },
                { pair: 3, values: [0n, 1n, 1n, 255n, 18446744073709551359n], note: "256 truncates to 0" },
                { pair: 4, values: [255n, 255n, 0n, 0n, 18446744073709486080n], note: "low byte all ones" },
                { pair: 5, values: [0n, 255n, 255n, 0n, 0n], note: "complement of all ones is zero" },
            ],
        }),
    ),
];
