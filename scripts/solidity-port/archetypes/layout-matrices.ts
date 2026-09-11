// Sizes and offsets, measured from inside the contract.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/structs";

interface LayoutProbe {
    prelude?: string;
    /** StateData members: uint64 measurements plus whatever the probe needs. */
    state: string;
    /** `Measure` body; `input.seed` is available. */
    body: string;
    locals?: string;
    /** `Read` output members, mirrored by name from state. */
    output: string;
    readBody: string;
    initialize: string;
    /** Expected `Read` output after the first Measure, when it follows from the alignment rule. */
    expect?: { values: bigint[]; note: string };
}

function layoutProbe(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, probe: (axis: AxisAssignment) => LayoutProbe): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["placement", "layout"],
        build(axis) {
            const shape = probe(axis);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: "layout probe",
                },
                prelude: shape.prelude,
                state: shape.state,
                entries: [
                    { name: "Measure", kind: "procedure", number: 1, input: "uint64 seed;", locals: shape.locals ?? "uint64 scratch;", body: shape.body },
                    { name: "Read", kind: "function", number: 1, output: shape.output, body: shape.readBody },
                ],
                initialize: shape.initialize,
            });
            const steps: CallStep[] = [
                { kind: "procedure", entry: 1, in: u64(1), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(255), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ];
            const built = script(steps);
            if (shape.expect) {
                built.expect = [{ step: 1, out: shape.expect.values.map((value) => u64(value)).join(""), source: "cpp-rule", note: shape.expect.note }];
            }
            return { source, script: built };
        },
    };
}

export const LAYOUT_MATRIX_ARCHETYPES: Archetype[] = [
    layoutProbe(
        {
            name: "SizeofScalarMatrix",
            family: "layout",
            solidity: `${SOL}/struct_packing.sol`,
            stresses:
                "sizeof of every QPI scalar in one contract — the base case every other layout question is built on, asserted rather than merely compared",
        },
        () => ({
            state: "uint64 u8Size;\nuint64 u16Size;\nuint64 u32Size;\nuint64 u64Size;\nuint64 s8Size;\nuint64 s64Size;\nuint64 u128Size;\nuint64 idSize;",
            body: `
                state.mut().u8Size = sizeof(uint8);
                state.mut().u16Size = sizeof(uint16);
                state.mut().u32Size = sizeof(uint32);
                state.mut().u64Size = sizeof(uint64);
                state.mut().s8Size = sizeof(sint8);
                state.mut().s64Size = sizeof(sint64);
                state.mut().u128Size = sizeof(uint128);
                state.mut().idSize = sizeof(id);
            `,
            output: "uint64 u8Size;\nuint64 u16Size;\nuint64 u32Size;\nuint64 u64Size;\nuint64 s8Size;\nuint64 s64Size;\nuint64 u128Size;\nuint64 idSize;",
            readBody: `
                output.u8Size = state.get().u8Size;
                output.u16Size = state.get().u16Size;
                output.u32Size = state.get().u32Size;
                output.u64Size = state.get().u64Size;
                output.s8Size = state.get().s8Size;
                output.s64Size = state.get().s64Size;
                output.u128Size = state.get().u128Size;
                output.idSize = state.get().idSize;
            `,
            initialize:
                "state.mut().u8Size = 0;\nstate.mut().u16Size = 0;\nstate.mut().u32Size = 0;\nstate.mut().u64Size = 0;\nstate.mut().s8Size = 0;\nstate.mut().s64Size = 0;\nstate.mut().u128Size = 0;\nstate.mut().idSize = 0;",
            expect: { values: [1n, 2n, 4n, 8n, 1n, 8n, 16n, 32n], note: "the QPI scalar widths, by definition" },
        }),
    ),

    layoutProbe(
        {
            name: "SizeofStructLadder",
            family: "layout",
            solidity: `${SOL}/struct_packing.sol`,
            stresses:
                "six structs adding one uint8 at a time to a uint64 base — the size steps by 8 only when the accumulated bytes cross the alignment, which is a rule a second implementation can get subtly wrong",
        },
        () => ({
            prelude: [
                "struct S0 { uint64 wide; };",
                "struct S1 { uint64 wide; uint8 a; };",
                "struct S2 { uint64 wide; uint8 a; uint8 b; };",
                "struct S4 { uint64 wide; uint8 a; uint8 b; uint8 c; uint8 d; };",
                "struct S8 { uint64 wide; uint8 a; uint8 b; uint8 c; uint8 d; uint8 e; uint8 f; uint8 g; uint8 h; };",
                "struct S9 { uint64 wide; uint8 a; uint8 b; uint8 c; uint8 d; uint8 e; uint8 f; uint8 g; uint8 h; uint8 i; };",
            ].join("\n\n"),
            state: "uint64 size0;\nuint64 size1;\nuint64 size2;\nuint64 size4;\nuint64 size8;\nuint64 size9;",
            body: `
                state.mut().size0 = sizeof(S0);
                state.mut().size1 = sizeof(S1);
                state.mut().size2 = sizeof(S2);
                state.mut().size4 = sizeof(S4);
                state.mut().size8 = sizeof(S8);
                state.mut().size9 = sizeof(S9);
            `,
            output: "uint64 size0;\nuint64 size1;\nuint64 size2;\nuint64 size4;\nuint64 size8;\nuint64 size9;",
            readBody: `
                output.size0 = state.get().size0;
                output.size1 = state.get().size1;
                output.size2 = state.get().size2;
                output.size4 = state.get().size4;
                output.size8 = state.get().size8;
                output.size9 = state.get().size9;
            `,
            initialize:
                "state.mut().size0 = 0;\nstate.mut().size1 = 0;\nstate.mut().size2 = 0;\nstate.mut().size4 = 0;\nstate.mut().size8 = 0;\nstate.mut().size9 = 0;",
            expect: { values: [8n, 16n, 16n, 16n, 16n, 24n], note: "eight bytes of tail room absorb up to eight uint8s; the ninth adds another eight" },
        }),
    ),

    layoutProbe(
        {
            name: "SizeofNestedArrayGrid",
            family: "layout",
            solidity: "test/libsolidity/semanticTests/array/multidim_array.sol",
            stresses: "sizeof of Array, Array of Array and Array of Array of Array — the product rule, checked at three depths and two element widths",
        },
        () => ({
            // Aliased first: `sizeof` of a template with more than one argument does not parse in the
            // TypeScript backend (F214), and this archetype is about layout rather than that parser.
            prelude:
                "using Flat = Array<uint64, 8>;\nusing Nested = Array<Flat, 4>;\nusing Cube = Array<Nested, 2>;\nusing NarrowFlat = Array<uint16, 8>;\nusing NarrowNested = Array<NarrowFlat, 4>;\nusing NarrowCube = Array<NarrowNested, 2>;",
            state: "uint64 flat;\nuint64 nested;\nuint64 cube;\nuint64 narrowFlat;\nuint64 narrowCube;",
            body: `
                state.mut().flat = sizeof(Flat);
                state.mut().nested = sizeof(Nested);
                state.mut().cube = sizeof(Cube);
                state.mut().narrowFlat = sizeof(NarrowFlat);
                state.mut().narrowCube = sizeof(NarrowCube);
            `,
            output: "uint64 flat;\nuint64 nested;\nuint64 cube;\nuint64 narrowFlat;\nuint64 narrowCube;",
            readBody: `
                output.flat = state.get().flat;
                output.nested = state.get().nested;
                output.cube = state.get().cube;
                output.narrowFlat = state.get().narrowFlat;
                output.narrowCube = state.get().narrowCube;
            `,
            initialize: "state.mut().flat = 0;\nstate.mut().nested = 0;\nstate.mut().cube = 0;\nstate.mut().narrowFlat = 0;\nstate.mut().narrowCube = 0;",
            expect: { values: [64n, 256n, 512n, 16n, 128n], note: "element size times capacity, at each nesting level" },
        }),
    ),

    layoutProbe(
        {
            name: "OffsetsBySizeofDifference",
            family: "layout",
            solidity: `${SOL}/struct_packing.sol`,
            stresses:
                "member offsets computed by measuring prefixes — sizeof of a struct with the first n members, so the difference between consecutive sizes is where the padding went",
        },
        () => ({
            prelude: [
                "struct P1 { uint8 a; };",
                "struct P2 { uint8 a; uint64 b; };",
                "struct P3 { uint8 a; uint64 b; uint16 c; };",
                "struct P4 { uint8 a; uint64 b; uint16 c; uint32 d; };",
            ].join("\n\n"),
            state: "uint64 p1;\nuint64 p2;\nuint64 p3;\nuint64 p4;\nuint64 paddingAfterFirst;\nuint64 paddingAtTail;",
            body: `
                state.mut().p1 = sizeof(P1);
                state.mut().p2 = sizeof(P2);
                state.mut().p3 = sizeof(P3);
                state.mut().p4 = sizeof(P4);
                state.mut().paddingAfterFirst = sizeof(P2) - sizeof(uint64) - sizeof(uint8);
                state.mut().paddingAtTail = sizeof(P4) - sizeof(uint8) - sizeof(uint64) - sizeof(uint16) - sizeof(uint32);
            `,
            output: "uint64 p1;\nuint64 p2;\nuint64 p3;\nuint64 p4;\nuint64 paddingAfterFirst;\nuint64 paddingAtTail;",
            readBody: `
                output.p1 = state.get().p1;
                output.p2 = state.get().p2;
                output.p3 = state.get().p3;
                output.p4 = state.get().p4;
                output.paddingAfterFirst = state.get().paddingAfterFirst;
                output.paddingAtTail = state.get().paddingAtTail;
            `,
            initialize:
                "state.mut().p1 = 0;\nstate.mut().p2 = 0;\nstate.mut().p3 = 0;\nstate.mut().p4 = 0;\nstate.mut().paddingAfterFirst = 0;\nstate.mut().paddingAtTail = 0;",
            expect: { values: [1n, 16n, 24n, 24n, 7n, 9n], note: "seven bytes pad the uint8 up to the uint64; the tail rounds 15 used bytes to 24" },
        }),
    ),

    layoutProbe(
        {
            name: "Uint128ArrayStride",
            family: "layout",
            solidity: `${SOL}/struct_packing.sol`,
            stresses: "an Array of uint128 written at both ends, with the neighbour read back — the widest scalar element stride QPI has",
        },
        () => ({
            prelude: "using WideArray = Array<uint128, 4>;",
            state: "Array<uint128, 4> wide;\nuint64 arraySize;\nuint64 elementSize;\nuint64 firstLow;\nuint64 lastLow;\nuint64 canary;",
            locals: "uint128 value;",
            body: `
                locals.value = (uint128)input.seed;
                locals.value = locals.value * (uint128)18446744073709551615ULL;
                state.mut().wide.set(0, locals.value);
                state.mut().wide.set(3, locals.value + (uint128)1);
                state.mut().arraySize = sizeof(WideArray);
                state.mut().elementSize = sizeof(uint128);
                state.mut().firstLow = state.get().wide.get(0).low;
                state.mut().lastLow = state.get().wide.get(3).low;
            `,
            output: "uint64 arraySize;\nuint64 elementSize;\nuint64 firstLow;\nuint64 lastLow;\nuint64 canary;",
            readBody: `
                output.arraySize = state.get().arraySize;
                output.elementSize = state.get().elementSize;
                output.firstLow = state.get().firstLow;
                output.lastLow = state.get().lastLow;
                output.canary = state.get().canary;
            `,
            initialize:
                "state.mut().arraySize = 0;\nstate.mut().elementSize = 0;\nstate.mut().firstLow = 0;\nstate.mut().lastLow = 0;\nstate.mut().canary = 18446744073709551615ULL;",
        }),
    ),

    layoutProbe(
        {
            name: "EnumArrayStride",
            family: "layout",
            solidity: "test/libsolidity/semanticTests/enums/enum_explicit_overflow.sol",
            stresses:
                "arrays of three enums with different constant ranges — the element stride is the underlying type the compiler chose, so the array sizes say what that choice was",
        },
        () => ({
            prelude:
                "enum Small { A = 0, B = 1 };\n\nenum Medium { C = 0, D = 300 };\n\nenum Large { E = 0, F = 100000 };\n\nusing SmallArray = Array<Small, 8>;\nusing MediumArray = Array<Medium, 8>;\nusing LargeArray = Array<Large, 8>;",
            state: "uint64 smallArray;\nuint64 mediumArray;\nuint64 largeArray;\nuint64 smallSize;\nuint64 mediumSize;\nuint64 largeSize;",
            body: `
                state.mut().smallArray = sizeof(SmallArray);
                state.mut().mediumArray = sizeof(MediumArray);
                state.mut().largeArray = sizeof(LargeArray);
                state.mut().smallSize = sizeof(Small);
                state.mut().mediumSize = sizeof(Medium);
                state.mut().largeSize = sizeof(Large);
            `,
            output: "uint64 smallArray;\nuint64 mediumArray;\nuint64 largeArray;\nuint64 smallSize;\nuint64 mediumSize;\nuint64 largeSize;",
            readBody: `
                output.smallArray = state.get().smallArray;
                output.mediumArray = state.get().mediumArray;
                output.largeArray = state.get().largeArray;
                output.smallSize = state.get().smallSize;
                output.mediumSize = state.get().mediumSize;
                output.largeSize = state.get().largeSize;
            `,
            initialize:
                "state.mut().smallArray = 0;\nstate.mut().mediumArray = 0;\nstate.mut().largeArray = 0;\nstate.mut().smallSize = 0;\nstate.mut().mediumSize = 0;\nstate.mut().largeSize = 0;",
        }),
    ),

    layoutProbe(
        {
            name: "StructOfArraysVersusArrayOfStructs",
            family: "layout",
            solidity: "test/libsolidity/semanticTests/array/array_of_structs.sol",
            stresses:
                "the same eight (uint64, uint8) pairs laid out both ways — as two arrays inside one struct and as one array of two-member structs — where the second carries seven bytes of padding per element",
        },
        () => ({
            prelude:
                "struct Pair { uint64 wide; uint8 narrow; };\n\nstruct StructOfArrays { Array<uint64, 8> wides; Array<uint8, 8> narrows; };\n\nstruct ArrayOfPairs { Array<Pair, 8> pairs; };",
            state: "uint64 structOfArrays;\nuint64 arrayOfStructs;\nuint64 pairSize;\nuint64 wasteBytes;",
            body: `
                state.mut().structOfArrays = sizeof(StructOfArrays);
                state.mut().arrayOfStructs = sizeof(ArrayOfPairs);
                state.mut().pairSize = sizeof(Pair);
                state.mut().wasteBytes = sizeof(ArrayOfPairs) - sizeof(StructOfArrays);
            `,
            output: "uint64 structOfArrays;\nuint64 arrayOfStructs;\nuint64 pairSize;\nuint64 wasteBytes;",
            readBody: `
                output.structOfArrays = state.get().structOfArrays;
                output.arrayOfStructs = state.get().arrayOfStructs;
                output.pairSize = state.get().pairSize;
                output.wasteBytes = state.get().wasteBytes;
            `,
            initialize: "state.mut().structOfArrays = 0;\nstate.mut().arrayOfStructs = 0;\nstate.mut().pairSize = 0;\nstate.mut().wasteBytes = 0;",
            expect: { values: [72n, 128n, 16n, 56n], note: "64+8 packed against 8 padded pairs of 16 bytes each" },
        }),
    ),

    layoutProbe(
        {
            name: "IdInsideNestedStructs",
            family: "layout",
            solidity: `${SOL}/struct_packing.sol`,
            stresses:
                "a 32-byte id three structs deep, with a uint8 at every level — the alignment of the widest member propagates outward, and each level's size says whether it did",
        },
        () => ({
            prelude:
                "struct Level3 { uint8 tag; id who; };\n\nstruct Level2 { uint8 tag; Level3 inner; };\n\nstruct Level1 { uint8 tag; Level2 inner; uint8 tail; };",
            state: "uint64 level3;\nuint64 level2;\nuint64 level1;\nuint64 idFirstWord;",
            locals: "Level1 value;",
            body: `
                locals.value.tag = (uint8)input.seed;
                locals.value.inner.tag = (uint8)(input.seed + 1);
                locals.value.inner.inner.tag = (uint8)(input.seed + 2);
                locals.value.inner.inner.who = qpi.K12(input.seed);
                locals.value.tail = (uint8)(input.seed + 3);
                state.mut().level3 = sizeof(Level3);
                state.mut().level2 = sizeof(Level2);
                state.mut().level1 = sizeof(Level1);
                state.mut().idFirstWord = locals.value.inner.inner.who.u64._0;
            `,
            output: "uint64 level3;\nuint64 level2;\nuint64 level1;\nuint64 idFirstWord;",
            readBody: `
                output.level3 = state.get().level3;
                output.level2 = state.get().level2;
                output.level1 = state.get().level1;
                output.idFirstWord = state.get().idFirstWord;
            `,
            initialize: "state.mut().level3 = 0;\nstate.mut().level2 = 0;\nstate.mut().level1 = 0;\nstate.mut().idFirstWord = 0;",
        }),
    ),

    layoutProbe(
        {
            name: "BitArraySizesLadder",
            family: "layout",
            solidity: "test/libsolidity/semanticTests/various/bit_operations.sol",
            stresses:
                "BitArray at five capacities — 2, 64, 65, 128 and 2048 — where the size is the number of 64-bit words needed, so the step from 64 to 65 is the interesting one",
        },
        () => ({
            prelude:
                "using Bits2 = BitArray<2>;\nusing Bits64 = BitArray<64>;\nusing Bits128 = BitArray<128>;\nusing Bits256 = BitArray<256>;\nusing Bits2048 = BitArray<2048>;",
            state: "uint64 bits2;\nuint64 bits64;\nuint64 bits65;\nuint64 bits128;\nuint64 bits2048;",
            body: `
                state.mut().bits2 = sizeof(Bits2);
                state.mut().bits64 = sizeof(Bits64);
                state.mut().bits65 = sizeof(Bits128);
                state.mut().bits128 = sizeof(Bits256);
                state.mut().bits2048 = sizeof(Bits2048);
            `,
            output: "uint64 bits2;\nuint64 bits64;\nuint64 bits65;\nuint64 bits128;\nuint64 bits2048;",
            readBody: `
                output.bits2 = state.get().bits2;
                output.bits64 = state.get().bits64;
                output.bits65 = state.get().bits65;
                output.bits128 = state.get().bits128;
                output.bits2048 = state.get().bits2048;
            `,
            initialize: "state.mut().bits2 = 0;\nstate.mut().bits64 = 0;\nstate.mut().bits65 = 0;\nstate.mut().bits128 = 0;\nstate.mut().bits2048 = 0;",
        }),
    ),

    layoutProbe(
        {
            name: "HashMapSizeAgainstCapacity",
            family: "layout",
            solidity: "test/libsolidity/semanticTests/mappings/mapping_of_mappings.sol",
            stresses:
                "sizeof of a HashMap at four capacities and two value widths — the table carries occupation bookkeeping beyond its entries, and how much is a layout fact both backends must share",
            caveat: "Solidity mappings have no size at all; this measures QPI's own container, which is why it has no original.",
        },
        () => ({
            prelude:
                "using Tiny = HashMap<uint64, uint64, 2>;\nusing Small = HashMap<uint64, uint64, 8>;\nusing Medium = HashMap<uint64, uint64, 64>;\nusing WideKey = HashMap<id, uint64, 8>;",
            state: "uint64 tiny;\nuint64 small;\nuint64 medium;\nuint64 wideValue;\nuint64 perEntry;",
            body: `
                state.mut().tiny = sizeof(Tiny);
                state.mut().small = sizeof(Small);
                state.mut().medium = sizeof(Medium);
                state.mut().wideValue = sizeof(WideKey);
                // Cast before dividing: sizeof yields an unsigned long, and QPI::div deduces one type.
                state.mut().perEntry = QPI::div((uint64)sizeof(Medium) - (uint64)sizeof(Small), 56ULL);
            `,
            output: "uint64 tiny;\nuint64 small;\nuint64 medium;\nuint64 wideValue;\nuint64 perEntry;",
            readBody: `
                output.tiny = state.get().tiny;
                output.small = state.get().small;
                output.medium = state.get().medium;
                output.wideValue = state.get().wideValue;
                output.perEntry = state.get().perEntry;
            `,
            initialize: "state.mut().tiny = 0;\nstate.mut().small = 0;\nstate.mut().medium = 0;\nstate.mut().wideValue = 0;\nstate.mut().perEntry = 0;",
        }),
    ),

    layoutProbe(
        {
            name: "SpacerLadderAroundArray",
            family: "layout",
            solidity: `${SOL}/struct_packing.sol`,
            stresses:
                "an array with one, two and three uint8 spacers in front of it, so the array's own alignment is forced from three different starting offsets",
        },
        () => ({
            prelude:
                "using Quad = Array<uint64, 4>;\n\nstruct Spaced1 { uint8 a; Array<uint64, 4> values; };\n\nstruct Spaced2 { uint8 a; uint8 b; Array<uint64, 4> values; };\n\nstruct Spaced3 { uint8 a; uint8 b; uint8 c; Array<uint64, 4> values; uint8 tail; };",
            state: "uint64 one;\nuint64 two;\nuint64 three;\nuint64 arrayOnly;",
            body: `
                state.mut().one = sizeof(Spaced1);
                state.mut().two = sizeof(Spaced2);
                state.mut().three = sizeof(Spaced3);
                state.mut().arrayOnly = sizeof(Quad);
            `,
            output: "uint64 one;\nuint64 two;\nuint64 three;\nuint64 arrayOnly;",
            readBody: `
                output.one = state.get().one;
                output.two = state.get().two;
                output.three = state.get().three;
                output.arrayOnly = state.get().arrayOnly;
            `,
            initialize: "state.mut().one = 0;\nstate.mut().two = 0;\nstate.mut().three = 0;\nstate.mut().arrayOnly = 0;",
            expect: {
                values: [40n, 40n, 48n, 32n],
                note: "the array aligns to 8, so one or two spacers cost the same eight bytes; the third struct adds a tail",
            },
        }),
    ),

    layoutProbe(
        {
            name: "WholeStructAssignmentAcrossPadding",
            family: "layout",
            solidity: `${SOL}/struct_assignment.sol`,
            stresses:
                "a whole-struct copy between two state members of a padded type, with a canary written into the destination first — if the copy carries padding bytes, the canary's neighbours move",
        },
        () => ({
            prelude: "struct Padded { uint8 first; uint64 wide; uint16 middle; uint8 last; };",
            state: "Padded source;\nuint64 guard;\nPadded destination;\nuint64 copies;\nuint64 fieldsMatch;",
            locals: "Padded staged;",
            body: `
                locals.staged.first = (uint8)input.seed;
                locals.staged.wide = input.seed * 1000003ULL;
                locals.staged.middle = (uint16)(input.seed + 7);
                locals.staged.last = (uint8)(input.seed + 9);
                state.mut().source = locals.staged;
                state.mut().destination = state.get().source;
                state.mut().copies++;
                state.mut().fieldsMatch =
                    state.get().destination.first == state.get().source.first && state.get().destination.wide == state.get().source.wide ? 1 : 0;
            `,
            output: "uint64 copies;\nuint64 fieldsMatch;\nuint64 guard;\nuint64 destinationWide;\nuint8 destinationLast;",
            readBody: `
                output.copies = state.get().copies;
                output.fieldsMatch = state.get().fieldsMatch;
                output.guard = state.get().guard;
                output.destinationWide = state.get().destination.wide;
                output.destinationLast = state.get().destination.last;
            `,
            initialize: "state.mut().guard = 12297829382473034410ULL;\nstate.mut().copies = 0;\nstate.mut().fieldsMatch = 0;",
        }),
    ),

    layoutProbe(
        {
            name: "SizeofMultiArgTemplate",
            family: "layout",
            solidity: `${SOL}/struct_packing.sol`,
            stresses:
                "`sizeof` applied directly to a template with two arguments — `sizeof(Array<uint64, 8>)` — next to the same measurement through a type alias, which parses",
            caveat: "The sizeof parser used to stop at the comma inside the template argument list, so this row was pinned as a divergence; it now reads the operand as a type-id and both backends agree at 64 bytes. Every other layout archetype still aliases the type first.",
            axes: ["placement"],
        },
        () => ({
            prelude: "using Aliased = Array<uint64, 8>;",
            state: "uint64 direct;\nuint64 viaAlias;\nuint64 equal;",
            body: `
                state.mut().direct = sizeof(Array<uint64, 8>);
                state.mut().viaAlias = sizeof(Aliased);
                state.mut().equal = state.get().direct == state.get().viaAlias ? 1 : 0;
            `,
            output: "uint64 direct;\nuint64 viaAlias;\nuint64 equal;",
            readBody: `
                output.direct = state.get().direct;
                output.viaAlias = state.get().viaAlias;
                output.equal = state.get().equal;
            `,
            initialize: "state.mut().direct = 0;\nstate.mut().viaAlias = 0;\nstate.mut().equal = 0;",
        }),
    ),
];
