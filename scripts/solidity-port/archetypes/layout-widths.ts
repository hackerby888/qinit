// Member widths and the padding they force.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/structs";

function drive(values: bigint[]): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry: 1, in: u64(value), invocator: 0, note: `value ${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

const VALUES = [0n, 1n, 255n, 65535n, 18446744073709551615n];

export const LAYOUT_WIDTH_ARCHETYPES: Archetype[] = [
    {
        name: "Uint128BetweenNarrowMembers",
        family: "layout",
        solidity: `${SOL}/struct_packing.sol`,
        stresses:
            "a uint128 with a uint8 either side — the widest scalar QPI has, whose alignment decides how much padding the two narrow members are pushed apart by",
        caveat: "Solidity has no uint128 alignment question: everything is slot-packed. The port is about C++ layout only. The low word is read as `.low`, not a `(uint64)` cast: uint128_t's only conversion operator is `explicit operator bool`, so the cast used to yield 1 or 0 and both backends agreed on a value that meant nothing.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "Uint128BetweenNarrowMembers",
                header: {
                    archetype: "Uint128BetweenNarrowMembers",
                    family: "layout",
                    solidity: `${SOL}/struct_packing.sol`,
                    stresses: "uint128 alignment between two uint8 members",
                    caveat: "no slot packing here",
                    axis: "uint128 alignment",
                },
                prelude: "struct Wide\n{\n    uint8 before;\n    uint128 middle;\n    uint8 after;\n};",
                state: "uint64 canaryBefore;\nWide wide;\nuint64 canaryAfter;\nuint64 size;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint128 wide;",
                        body: `
                            locals.wide = (uint128)input.value;
                            locals.wide = locals.wide * (uint128)4294967296ULL;
                            state.mut().wide.before = (uint8)input.value;
                            state.mut().wide.middle = locals.wide;
                            state.mut().wide.after = (uint8)(input.value + 1);
                            state.mut().size = sizeof(Wide);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint8 before;\nuint8 after;\nuint64 middleLow;\nuint64 canaryBefore;\nuint64 canaryAfter;\nuint64 size;",
                        locals: "uint128 middle;",
                        body: `
                            locals.middle = state.get().wide.middle;
                            output.before = state.get().wide.before;
                            output.after = state.get().wide.after;
                            output.middleLow = locals.middle.low;
                            output.canaryBefore = state.get().canaryBefore;
                            output.canaryAfter = state.get().canaryAfter;
                            output.size = state.get().size;
                        `,
                    },
                ],
                initialize:
                    "state.mut().canaryBefore = 12297829382473034410ULL;\nstate.mut().canaryAfter = 14757395258967641292ULL;\nstate.mut().size = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "IdBetweenNarrowMembers",
        family: "layout",
        solidity: `${SOL}/struct_packing.sol`,
        stresses:
            "a 32-byte id between two uint8 members, with the id written from a K12 so its bytes are all distinct — the widest member QPI has and the one most likely to be over-aligned",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "IdBetweenNarrowMembers",
                header: {
                    archetype: "IdBetweenNarrowMembers",
                    family: "layout",
                    solidity: `${SOL}/struct_packing.sol`,
                    stresses: "id alignment between two uint8 members",
                    axis: "id alignment",
                },
                prelude: "struct Holder\n{\n    uint8 before;\n    id who;\n    uint8 after;\n};",
                state: "uint64 canaryBefore;\nHolder holder;\nuint64 canaryAfter;\nuint64 size;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "id derived;",
                        body: `
                            locals.derived = qpi.K12(input.value);
                            state.mut().holder.before = (uint8)input.value;
                            state.mut().holder.who = locals.derived;
                            state.mut().holder.after = (uint8)(input.value + 3);
                            state.mut().size = sizeof(Holder);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint8 before;\nuint8 after;\nuint64 idFirstWord;\nuint64 canaryBefore;\nuint64 canaryAfter;\nuint64 size;",
                        body: `
                            output.before = state.get().holder.before;
                            output.after = state.get().holder.after;
                            output.idFirstWord = state.get().holder.who.u64._0;
                            output.canaryBefore = state.get().canaryBefore;
                            output.canaryAfter = state.get().canaryAfter;
                            output.size = state.get().size;
                        `,
                    },
                ],
                initialize:
                    "state.mut().canaryBefore = 12297829382473034410ULL;\nstate.mut().canaryAfter = 14757395258967641292ULL;\nstate.mut().size = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "EmptyStructMemberSize",
        family: "layout",
        solidity: `${SOL}/empty_struct.sol`,
        stresses:
            "an empty struct as a member — C++ gives it a size of one byte and the padding around it follows, which is the kind of rule two independent implementations can differ on",
        caveat: "Solidity rejects an empty struct outright, so this exists only on the QPI side.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EmptyStructMemberSize",
                header: {
                    archetype: "EmptyStructMemberSize",
                    family: "layout",
                    solidity: `${SOL}/empty_struct.sol`,
                    stresses: "the size of an empty struct member and its effect on neighbours",
                    caveat: "Solidity forbids empty structs",
                    axis: "empty struct",
                },
                prelude: "struct Marker\n{\n};\n\nstruct Framed\n{\n    uint64 first;\n    Marker marker;\n    uint64 second;\n};",
                state: "Framed framed;\nuint64 markerSize;\nuint64 framedSize;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value;
                            state.mut().framed.first = locals.scratch;
                            state.mut().framed.second = locals.scratch * 2;
                            state.mut().markerSize = sizeof(Marker);
                            state.mut().framedSize = sizeof(Framed);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 first;\nuint64 second;\nuint64 markerSize;\nuint64 framedSize;\nuint64 writes;",
                        body: `
                            output.first = state.get().framed.first;
                            output.second = state.get().framed.second;
                            output.markerSize = state.get().markerSize;
                            output.framedSize = state.get().framedSize;
                            output.writes = state.get().writes;
                        `,
                    },
                ],
                initialize: "state.mut().markerSize = 0;\nstate.mut().framedSize = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "ArrayOfIdStride",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/array/fixed_arrays_in_storage.sol",
        stresses:
            "an Array of 32-byte ids written at the first, last and one-past-the-end index — the largest element stride QPI has, where a masked index writes a different entry entirely",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = Math.min(8, capacityOf(axis, 4));
            const source = emitContract({
                axis,
                name: "ArrayOfIdStride",
                header: {
                    archetype: "ArrayOfIdStride",
                    family: "layout",
                    solidity: "array/fixed_arrays_in_storage.sol",
                    stresses: "32-byte element stride and index masking",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<id, ${capacity}> holders;\nuint64 canary;\nuint64 writes;`,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;\nuint64 seed;",
                        locals: "id derived;",
                        body: `
                            locals.derived = qpi.K12(input.seed);
                            state.mut().holders.set(input.index, locals.derived);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 index;",
                        output: "uint64 firstWord;\nuint64 lastWord;\nuint64 neighbourFirstWord;\nuint64 canary;\nuint64 writes;",
                        body: `
                            output.firstWord = state.get().holders.get(input.index).u64._0;
                            output.lastWord = state.get().holders.get(input.index).u64._3;
                            output.neighbourFirstWord = state.get().holders.get(input.index + 1).u64._0;
                            output.canary = state.get().canary;
                            output.writes = state.get().writes;
                        `,
                    },
                ],
                initialize: "state.mut().holders.setAll(NULL_ID);\nstate.mut().canary = 18446744073709551615ULL;\nstate.mut().writes = 0;",
            });
            const steps: CallStep[] = [];
            for (const [index, seed] of [
                [0n, 1n],
                [BigInt(capacity - 1), 2n],
                [BigInt(capacity), 3n],
                [BigInt(capacity) + 1n, 4n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(index) + u64(seed), invocator: 0, note: `index ${index}` });
                steps.push({ kind: "function", entry: 1, in: u64(index) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "NestedStructTailPadding",
        family: "layout",
        solidity: `${SOL}/struct_packing.sol`,
        stresses:
            "an inner struct that ends on a one-byte member, nested inside an outer struct that continues with a uint64 — the tail padding has to be inside the inner struct, not absorbed by the outer",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NestedStructTailPadding",
                header: {
                    archetype: "NestedStructTailPadding",
                    family: "layout",
                    solidity: `${SOL}/struct_packing.sol`,
                    stresses: "tail padding of a nested struct",
                    axis: "nested tail padding",
                },
                prelude: "struct Leaf\n{\n    uint64 wide;\n    uint8 narrow;\n};\n\nstruct Frame\n{\n    Leaf leaf;\n    uint64 after;\n    uint8 last;\n};",
                state: "Frame frame;\nuint64 leafSize;\nuint64 frameSize;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "Leaf staged;",
                        body: `
                            locals.staged.wide = input.value;
                            locals.staged.narrow = (uint8)input.value;
                            state.mut().frame.leaf = locals.staged;
                            state.mut().frame.after = input.value * 3;
                            state.mut().frame.last = (uint8)(input.value + 7);
                            state.mut().leafSize = sizeof(Leaf);
                            state.mut().frameSize = sizeof(Frame);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 leafWide;\nuint8 leafNarrow;\nuint64 after;\nuint8 last;\nuint64 leafSize;\nuint64 frameSize;",
                        body: `
                            output.leafWide = state.get().frame.leaf.wide;
                            output.leafNarrow = state.get().frame.leaf.narrow;
                            output.after = state.get().frame.after;
                            output.last = state.get().frame.last;
                            output.leafSize = state.get().leafSize;
                            output.frameSize = state.get().frameSize;
                        `,
                    },
                ],
                initialize: "state.mut().leafSize = 0;\nstate.mut().frameSize = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "EnumMembersInStruct",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/enums/enum_explicit_overflow.sol",
        stresses:
            "three enum members in one struct, each with a different range of constants — the underlying type C++ picks decides the struct's size, and the two backends have to pick the same one",
        caveat: "Solidity enums are always one byte up to 256 members; C++ picks an underlying type per enum, so the port can differ from the original by design.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EnumMembersInStruct",
                header: {
                    archetype: "EnumMembersInStruct",
                    family: "layout",
                    solidity: "enums/enum_explicit_overflow.sol",
                    stresses: "underlying width of three differently ranged enums",
                    caveat: "Solidity enums are one byte; C++ chooses",
                    axis: "enum widths",
                },
                prelude:
                    "enum Tiny { A = 0, B = 1 };\n\nenum Medium { C = 0, D = 300 };\n\nenum Large { E = 0, F = 70000 };\n\nstruct Mixed\n{\n    Tiny tiny;\n    Medium medium;\n    Large large;\n    uint8 tail;\n};",
                state: "Mixed mixed;\nuint64 mixedSize;\nuint64 tinySize;\nuint64 mediumSize;\nuint64 largeSize;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value;
                            state.mut().mixed.tiny = locals.scratch > 0 ? B : A;
                            state.mut().mixed.medium = locals.scratch > 1 ? D : C;
                            state.mut().mixed.large = locals.scratch > 2 ? F : E;
                            state.mut().mixed.tail = (uint8)locals.scratch;
                            state.mut().mixedSize = sizeof(Mixed);
                            state.mut().tinySize = sizeof(Tiny);
                            state.mut().mediumSize = sizeof(Medium);
                            state.mut().largeSize = sizeof(Large);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 mixedSize;\nuint64 tinySize;\nuint64 mediumSize;\nuint64 largeSize;\nuint64 tinyValue;\nuint64 largeValue;",
                        body: `
                            output.mixedSize = state.get().mixedSize;
                            output.tinySize = state.get().tinySize;
                            output.mediumSize = state.get().mediumSize;
                            output.largeSize = state.get().largeSize;
                            output.tinyValue = (uint64)state.get().mixed.tiny;
                            output.largeValue = (uint64)state.get().mixed.large;
                        `,
                    },
                ],
                initialize:
                    "state.mut().mixedSize = 0;\nstate.mut().tinySize = 0;\nstate.mut().mediumSize = 0;\nstate.mut().largeSize = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive([0n, 1n, 2n, 3n, 4n])) };
        },
    },

    {
        name: "SignedNarrowNeighbourBleed",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/storage/packed_storage_signed.sol",
        stresses:
            "sint8 and sint16 neighbours written at their extremes, with the negation the Solidity original performs — a store that writes one byte too many changes the neighbour rather than failing",
        caveat: "The original packs four signed members into one slot; the port keeps the members and the arithmetic and lets C++ place them.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "SignedNarrowNeighbourBleed",
                header: {
                    archetype: "SignedNarrowNeighbourBleed",
                    family: "layout",
                    solidity: "storage/packed_storage_signed.sol",
                    stresses: "signed narrow members at their extremes, next to each other",
                    caveat: "slot packing becomes C++ placement",
                    axis: "signed neighbours",
                },
                state: "sint8 a;\nuint8 b;\nsint8 c;\nsint16 d;\nuint16 e;\nuint64 guard;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "sint64 value;",
                        locals: "sint64 scratch;",
                        body: `
                            locals.scratch = input.value;
                            state.mut().a = (sint8)locals.scratch;
                            // The original's line: b = (0 - uint8(a)) * 2.
                            state.mut().b = (uint8)((0 - (uint8)state.get().a) * 2);
                            state.mut().c = (sint8)(0 - locals.scratch);
                            state.mut().d = (sint16)(locals.scratch * 3);
                            state.mut().e = (uint16)(0 - (uint16)state.get().d);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint8 a;\nuint8 b;\nsint8 c;\nsint16 d;\nuint16 e;\nuint64 guard;",
                        body: `
                            output.a = state.get().a;
                            output.b = state.get().b;
                            output.c = state.get().c;
                            output.d = state.get().d;
                            output.e = state.get().e;
                            output.guard = state.get().guard;
                        `,
                    },
                ],
                initialize:
                    "state.mut().a = 0;\nstate.mut().b = 0;\nstate.mut().c = 0;\nstate.mut().d = 0;\nstate.mut().e = 0;\nstate.mut().guard = 18446744073709551615ULL;",
            });
            const steps: CallStep[] = [];
            for (const value of [0n, 1n, -1n, 127n, -128n, 32767n, -32768n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(value), invocator: 0, note: `value ${value}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "BitMembersMixedWithScalars",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/types/bool_storage.sol",
        stresses:
            "QPI `bit` members interleaved with scalars — a boolean-sized member whose storage width is a layout decision, written from comparisons rather than literals",
        caveat: "Solidity packs bools one per byte inside a slot; the QPI `bit` type is its own typedef and the port compares how the two backends size it.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "BitMembersMixedWithScalars",
                header: {
                    archetype: "BitMembersMixedWithScalars",
                    family: "layout",
                    solidity: "types/bool_storage.sol",
                    stresses: "bit members between scalars",
                    caveat: "bool packing differs from Solidity by construction",
                    axis: "bit members",
                },
                prelude: "struct Flags\n{\n    bit first;\n    uint64 middle;\n    bit second;\n    uint8 tail;\n};",
                state: "Flags flags;\nuint64 flagsSize;\nuint64 bitSize;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value;
                            state.mut().flags.first = locals.scratch > 0;
                            state.mut().flags.middle = locals.scratch;
                            state.mut().flags.second = locals.scratch > 100;
                            state.mut().flags.tail = (uint8)locals.scratch;
                            state.mut().flagsSize = sizeof(Flags);
                            state.mut().bitSize = sizeof(bit);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 first;\nuint64 second;\nuint64 middle;\nuint8 tail;\nuint64 flagsSize;\nuint64 bitSize;",
                        body: `
                            output.first = state.get().flags.first ? 1 : 0;
                            output.second = state.get().flags.second ? 1 : 0;
                            output.middle = state.get().flags.middle;
                            output.tail = state.get().flags.tail;
                            output.flagsSize = state.get().flagsSize;
                            output.bitSize = state.get().bitSize;
                        `,
                    },
                ],
                initialize: "state.mut().flagsSize = 0;\nstate.mut().bitSize = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "LayoutNestedStructNameCollision",
        family: "layout",
        solidity: `${SOL}/struct_packing.sol`,
        stresses:
            "a file-scope struct named `Inner` while the contract's own state carries a nested struct of the same name, and a file-scope struct whose member is typed by the outer one — C++ binds that member at its declaration, so there is no recursion",
        caveat: "A nested struct sharing a file-scope struct's name used to make the front end resolve the member type in the use scope and recurse until the stack ran out. Every struct now resolves its fields in the scope that declares it, file, contract or nested alike.",
        axes: ["layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LayoutNestedStructNameCollision",
                header: {
                    archetype: "LayoutNestedStructNameCollision",
                    family: "layout",
                    solidity: `${SOL}/struct_packing.sol`,
                    stresses: "a nested struct name colliding with a file-scope struct",
                    caveat: "a member type binds where the struct is declared, not where the layout walk arrives",
                    axis: "nested name collision",
                },
                prelude: "struct Inner\n{\n    uint64 wide;\n    uint8 narrow;\n};\n\nstruct Frame\n{\n    Inner inner;\n    uint64 after;\n};",
                // Forced, not taken from the axis: the collision only exists when the emitter wraps the
                // state members in a struct of its own called Inner.
                statePlacement: "nested",
                state: "Frame frame;\nuint64 frameSize;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "Inner staged;",
                        body: `
                            locals.staged.wide = input.value;
                            locals.staged.narrow = (uint8)input.value;
                            state.mut().frame.inner = locals.staged;
                            state.mut().frame.after = input.value * 2;
                            state.mut().frameSize = sizeof(Frame);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 wide;\nuint8 narrow;\nuint64 after;\nuint64 frameSize;\nuint64 writes;",
                        body: `
                            output.wide = state.get().frame.inner.wide;
                            output.narrow = state.get().frame.inner.narrow;
                            output.after = state.get().frame.after;
                            output.frameSize = state.get().frameSize;
                            output.writes = state.get().writes;
                        `,
                    },
                ],
                initialize: "state.mut().frameSize = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },
];
