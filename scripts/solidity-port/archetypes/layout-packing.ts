// Packed-field layout: neighbour bleed, canaries and self-describing offsets.
//
// Ported from Solidity's `storage/packed_*` family. Solidity packs several small fields into one 32-byte
// slot and its tests exist to prove that writing one does not disturb the next; QPI lays fields out by
// C++ rules, so the same question becomes "does a narrow store touch the adjacent member". Every
// archetype here carries a canary field whose value is checked after every write, so a stray byte shows
// up as a wrong number rather than as padding nobody reads.

import { emitContract } from "../emit";
import { orderFields, widthOf } from "../axes";
import { script } from "./common";
import { maxOf, u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/storage";

/** A value with every byte distinct, so a field that shifts by one byte is immediately visible. */
const DISTINCT = 0xfedcba9876543210n;

const WRITE_READ: CallStep[] = [
    { kind: "procedure", entry: 1, in: u64(1), invocator: 0 },
    { kind: "function", entry: 1 },
    { kind: "procedure", entry: 1, in: u64(DISTINCT), invocator: 0, note: "every byte distinct" },
    { kind: "function", entry: 1 },
    { kind: "procedure", entry: 1, in: u64(18446744073709551615n), invocator: 0 },
    { kind: "function", entry: 1 },
    { kind: "advanceTick", n: 1 },
];

export const LAYOUT_PACKING_ARCHETYPES: Archetype[] = [
    {
        name: "PackedSignedNeighbourBleed",
        family: "layout",
        solidity: `${SOL}/packed_storage_signed.sol`,
        stresses: "int8/uint8 adjacency: the Solidity original computes `b = (0 - uint8(a)) * 2` and `c = a * 120 * 121` and asserts -2, 4, -112, 0 — sign extension on load of a sub-word field, and no bleed into the neighbour",
        caveat: "Solidity needs `unchecked` for the wrap; QPI wraps natively, so the arithmetic is written directly.",
        axes: ["layout", "placement", "temporaries"],
        build(axis: AxisAssignment) {
            const ordered = orderFields(axis, [
                { declaration: "sint8 a;", bytes: 1 },
                { declaration: "uint8 b;", bytes: 1 },
                { declaration: "sint8 c;", bytes: 1 },
                { declaration: "uint8 d;", bytes: 1 },
            ]);
            const source = emitContract({
                axis,
                name: "PackedSignedNeighbourBleed",
                header: {
                    archetype: "PackedSignedNeighbourBleed",
                    family: "layout",
                    solidity: `${SOL}/packed_storage_signed.sol`,
                    stresses: "signed sub-word fields packed adjacently",
                    caveat: "wrap is native in QPI, so no `unchecked` block is needed",
                    axis: `layout=${axis.layout ?? "declared"}`,
                },
                prelude: `struct Packed\n{\n${ordered
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n")}\n};`,
                state: "Packed packed;\nsint64 widenedA;\nsint64 widenedC;\nuint64 canary;",
                statePlacement: axis.placement,
                temporaries: axis.temporaries,
                entries: [
                    {
                        name: "Compute",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "sint8 signedSeed;",
                        body: `
                            state.mut().canary = 0x0123456789abcdefULL;
                            locals.signedSeed = (sint8)input.seed;
                            state.mut().packed.a = locals.signedSeed;
                            state.mut().packed.b = (uint8)((uint8)0 - (uint8)state.get().packed.a) * 2;
                            state.mut().packed.c = state.get().packed.a * (sint8)120 * (sint8)121;
                            state.mut().packed.d = 0;
                            // Widening on load is where a sub-word sign bit is lost.
                            state.mut().widenedA = (sint64)state.get().packed.a;
                            state.mut().widenedC = (sint64)state.get().packed.c;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 widenedA;\nsint64 widenedC;\nuint64 b;\nuint64 d;\nuint64 canary;",
                        body: `
                            output.widenedA = state.get().widenedA;
                            output.widenedC = state.get().widenedC;
                            output.b = (uint64)state.get().packed.b;
                            output.d = (uint64)state.get().packed.d;
                            output.canary = state.get().canary;
                        `,
                    },
                ],
                initialize: "state.mut().widenedA = 0;\nstate.mut().widenedC = 0;\nstate.mut().canary = 0;",
            });
            const steps: CallStep[] = [];
            for (const seed of [0xfen, 0x80n, 0x7fn, 0n, 1n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(seed), invocator: 0, note: `a = ${seed}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "PackedNeighbourOverflowCanary",
        family: "layout",
        solidity: `${SOL}/packed_storage_overflow.sol`,
        stresses: "wrapping one uint16 must not touch the adjacent uint16 — the Solidity original asserts 0x1234, 0, 0, 0xfffe after `a++` then `a -= 2`",
        caveat: "Solidity's `delete b` becomes an explicit `b = 0`.",
        axes: ["width", "placement", "layout"],
        build(axis) {
            const width = widthOf(axis, "uint16");
            const source = emitContract({
                axis,
                name: "PackedNeighbourOverflowCanary",
                header: {
                    archetype: "PackedNeighbourOverflowCanary",
                    family: "layout",
                    solidity: `${SOL}/packed_storage_overflow.sol`,
                    stresses: "wraparound confined to its own field",
                    axis: `width=${width}`,
                },
                state: `${width} x;\n${width} a;\n${width} b;\nuint64 captured;`,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Wrap",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().x = (${width})0x1234;
                            state.mut().a = (${width})input.seed;
                            state.mut().b = 0;
                            state.mut().a++;
                            locals.scratch = (uint64)state.get().b;
                            state.mut().b = 0;
                            state.mut().a -= 2;
                            state.mut().captured = locals.scratch;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${width} x;\n${width} a;\n${width} b;\nuint64 captured;`,
                        body: `
                            output.x = state.get().x;
                            output.a = state.get().a;
                            output.b = state.get().b;
                            output.captured = state.get().captured;
                        `,
                    },
                ],
                initialize: "state.mut().x = 0;\nstate.mut().a = 0;\nstate.mut().b = 0;\nstate.mut().captured = 0;",
            });
            const steps: CallStep[] = [];
            for (const seed of [maxOf(width), 0n, 1n, maxOf(width) - 1n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(seed), invocator: 0, note: `a starts at ${seed}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "CanaryAfterArrayFill",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/storage/storage_boundary_array_assignment.sol",
        stresses: "a whole-array fill must not overrun into the scalar declared after it — the canary is the assertion",
        axes: ["capacity", "placement", "loopShape"],
        build(axis) {
            const capacity = axis.capacity ?? 8;
            const source = emitContract({
                axis,
                name: "CanaryAfterArrayFill",
                header: {
                    archetype: "CanaryAfterArrayFill",
                    family: "layout",
                    solidity: "storage/storage_boundary_array_assignment.sol",
                    stresses: "array fill bounded by a canary",
                    axis: `capacity=${capacity}`,
                },
                state: `uint64 canaryBefore;\nArray<uint64, ${capacity}> slots;\nuint64 canaryAfter;\nuint64 checksum;`,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;\nuint64 value;",
                        locals: "uint64 i;\nuint64 bound;\nuint64 total;",
                        body: `
                            state.mut().canaryBefore = 0x1111111111111111ULL;
                            state.mut().canaryAfter = 0x2222222222222222ULL;
                            locals.bound = input.count;
                            if (locals.bound > ${capacity})
                            {
                                locals.bound = ${capacity};
                            }
                            for (locals.i = 0; locals.i < locals.bound; locals.i++)
                            {
                                state.mut().slots.set(locals.i, input.value + locals.i);
                            }
                            locals.total = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.total += state.get().slots.get(locals.i);
                            }
                            state.mut().checksum = locals.total;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 canaryBefore;\nuint64 canaryAfter;\nuint64 checksum;",
                        body: `
                            output.canaryBefore = state.get().canaryBefore;
                            output.canaryAfter = state.get().canaryAfter;
                            output.checksum = state.get().checksum;
                        `,
                    },
                ],
                initialize: "state.mut().slots.setAll(0);\nstate.mut().canaryBefore = 0;\nstate.mut().canaryAfter = 0;\nstate.mut().checksum = 0;",
            });
            const steps: CallStep[] = [];
            for (const count of [0, 1, capacity - 1, capacity, capacity + 4]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(count) + u64(7), invocator: 0, note: `fill ${count} of ${capacity}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "MixedWidthStructArrayStride",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/storage/storage_boundary_struct_array_mixed_types.sol",
        stresses: "the element stride of an Array<S,N> whose S mixes id, uint128, uint64, uint32 and bit — a stride that disagrees writes into the neighbouring element",
        caveat: "The Solidity original reaches into storage slots with assembly; the port uses two adjacent arrays and a canary instead.",
        axes: ["capacity", "layout"],
        build(axis) {
            const capacity = axis.capacity && axis.capacity <= 8 ? axis.capacity : 4;
            const ordered = orderFields(axis, [
                { declaration: "id owner;", bytes: 32 },
                { declaration: "uint128 huge;", bytes: 16 },
                { declaration: "uint64 wide;", bytes: 8 },
                { declaration: "uint32 medium;", bytes: 4 },
                { declaration: "bit flag;", bytes: 1 },
            ]);
            const source = emitContract({
                axis,
                name: "MixedWidthStructArrayStride",
                header: {
                    archetype: "MixedWidthStructArrayStride",
                    family: "layout",
                    solidity: "storage/storage_boundary_struct_array_mixed_types.sol",
                    stresses: "stride of an array of wide mixed-width structs",
                    axis: `capacity=${capacity} layout=${axis.layout ?? "declared"}`,
                },
                prelude: `struct Element\n{\n${ordered
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n")}\n};`,
                state: `Array<Element, ${capacity}> elements;\nArray<uint64, ${capacity}> neighbours;\nuint64 elementSize;\nuint64 checksum;`,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: `uint64 i;\nuint64 bound;\nElement scratch;\nuint64 total;`,
                        body: `
                            locals.bound = input.count;
                            if (locals.bound > ${capacity})
                            {
                                locals.bound = ${capacity};
                            }
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                state.mut().neighbours.set(locals.i, 0x7777777777777777ULL);
                            }
                            for (locals.i = 0; locals.i < locals.bound; locals.i++)
                            {
                                locals.scratch.owner = qpi.invocator();
                                locals.scratch.huge = (uint128)(locals.i + 1);
                                locals.scratch.wide = locals.i + 2;
                                locals.scratch.medium = (uint32)(locals.i + 3);
                                locals.scratch.flag = 1;
                                state.mut().elements.set(locals.i, locals.scratch);
                            }
                            locals.total = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.total += state.get().elements.get(locals.i).wide;
                                locals.total += (uint64)state.get().elements.get(locals.i).medium;
                                locals.total += state.get().neighbours.get(locals.i);
                            }
                            state.mut().checksum = locals.total;
                            state.mut().elementSize = sizeof(Element);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 elementSize;\nuint64 checksum;",
                        body: "output.elementSize = state.get().elementSize;\noutput.checksum = state.get().checksum;",
                    },
                ],
                initialize: "state.mut().neighbours.setAll(0);\nstate.mut().elementSize = 0;\nstate.mut().checksum = 0;",
            });
            const steps: CallStep[] = [];
            for (const count of [1, capacity, capacity + 2]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(count), invocator: 0, note: `fill ${count}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "TwoDimArrayRowMajor",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/array/array_2d_assignment.sol",
        stresses: "row-major stride of Array<Array<T,N>,M>: writing one cell must leave every other cell alone",
        axes: ["capacity", "width"],
        build(axis) {
            const capacity = axis.capacity && axis.capacity <= 8 ? axis.capacity : 4;
            const width = widthOf(axis, "uint64");
            const source = emitContract({
                axis,
                name: "TwoDimArrayRowMajor",
                header: {
                    archetype: "TwoDimArrayRowMajor",
                    family: "layout",
                    solidity: "array/array_2d_assignment.sol",
                    stresses: "two-dimensional stride",
                    axis: `capacity=${capacity} width=${width}`,
                },
                state: `Array<Array<${width}, ${capacity}>, ${capacity}> grid;\nuint64 checksum;\nuint64 gridSize;`,
                entries: [
                    {
                        name: "Poke",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 row;\nuint64 column;\nuint64 value;",
                        locals: `uint64 r;\nuint64 c;\nuint64 total;\nArray<${width}, ${capacity}> line;`,
                        body: `
                            locals.line = state.get().grid.get(input.row);
                            locals.line.set(input.column, (${width})input.value);
                            state.mut().grid.set(input.row, locals.line);
                            locals.total = 0;
                            for (locals.r = 0; locals.r < ${capacity}; locals.r++)
                            {
                                for (locals.c = 0; locals.c < ${capacity}; locals.c++)
                                {
                                    locals.total += (uint64)state.get().grid.get(locals.r).get(locals.c);
                                }
                            }
                            state.mut().checksum = locals.total;
                            state.mut().gridSize = sizeof(state.get().grid);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 checksum;\nuint64 gridSize;",
                        body: "output.checksum = state.get().checksum;\noutput.gridSize = state.get().gridSize;",
                    },
                ],
                initialize: "state.mut().checksum = 0;\nstate.mut().gridSize = 0;",
            });
            const steps: CallStep[] = [];
            for (const [row, column] of [
                [0n, 0n],
                [1n, 1n],
                [BigInt(capacity - 1), BigInt(capacity - 1)],
                [BigInt(capacity), BigInt(capacity)],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(row) + u64(column) + u64(9), invocator: 0, note: `grid[${row}][${column}]` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "IdFieldAlignmentProbe",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/getters/value_types.sol",
        stresses: "a 32-byte id sandwiched between narrow fields — padding before and after, and the neighbours' values across a rewrite",
        axes: ["layout", "placement", "initStyle"],
        build(axis) {
            const ordered = orderFields(axis, [
                { declaration: "uint8 before;", bytes: 1 },
                { declaration: "id middle;", bytes: 32 },
                { declaration: "uint16 after;", bytes: 2 },
            ]);
            const source = emitContract({
                axis,
                name: "IdFieldAlignmentProbe",
                header: {
                    archetype: "IdFieldAlignmentProbe",
                    family: "layout",
                    solidity: "getters/value_types.sol",
                    stresses: "id alignment between narrow neighbours",
                    axis: `layout=${axis.layout ?? "declared"} initStyle=${axis.initStyle ?? "full"}`,
                },
                prelude: `struct Holder\n{\n${ordered
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n")}\n};`,
                state: "Holder holder;\nuint64 holderSize;\nuint64 sameAsSelf;",
                statePlacement: axis.placement,
                initStyle: axis.initStyle,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().holder.before = (uint8)input.seed;
                            state.mut().holder.middle = qpi.invocator();
                            state.mut().holder.after = (uint16)input.seed;
                            state.mut().holderSize = sizeof(Holder);
                            state.mut().sameAsSelf = (state.get().holder.middle == qpi.invocator()) ? 1 : 0;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 before;\nuint64 after;\nuint64 holderSize;\nuint64 sameAsSelf;",
                        body: `
                            output.before = (uint64)state.get().holder.before;
                            output.after = (uint64)state.get().holder.after;
                            output.holderSize = state.get().holderSize;
                            output.sameAsSelf = state.get().sameAsSelf;
                        `,
                    },
                ],
                initialize: "state.mut().holderSize = 0;\nstate.mut().sameAsSelf = 0;",
            });
            return { source, script: script(WRITE_READ) };
        },
    },

    {
        name: "BitArrayVsBoolArrayParity",
        family: "layout",
        solidity: "OpenZeppelin utils/structs/BitMaps.sol",
        stresses: "a BitArray<N> and an Array<bit,N> driven with the same index stream must agree on every index",
        caveat: "OpenZeppelin's BitMaps does the bucket math by hand (`index >> 8`, `1 << (index & 0xff)`); QPI's BitArray does it internally, so the port compares the two.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = axis.capacity && axis.capacity >= 64 ? axis.capacity : 64;
            const source = emitContract({
                axis,
                name: "BitArrayVsBoolArrayParity",
                header: {
                    archetype: "BitArrayVsBoolArrayParity",
                    family: "layout",
                    solidity: "OpenZeppelin BitMaps.setTo/get",
                    stresses: "packed bit storage against one-byte-per-flag storage",
                    axis: `capacity=${capacity}`,
                },
                state: `BitArray<${capacity}> bits;\nArray<bit, ${capacity}> flags;\nuint64 disagreements;\nuint64 setCount;`,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "SetPattern",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 stride;",
                        locals: "uint64 i;\nuint64 count;\nuint64 mismatches;\nbit wanted;",
                        body: `
                            locals.count = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.wanted = (QPI::mod(locals.i, input.stride + 1) == 0) ? 1 : 0;
                                state.mut().bits.set(locals.i, locals.wanted);
                                state.mut().flags.set(locals.i, locals.wanted);
                                if (locals.wanted == 1)
                                {
                                    locals.count++;
                                }
                            }
                            locals.mismatches = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                if (state.get().bits.get(locals.i) != state.get().flags.get(locals.i))
                                {
                                    locals.mismatches++;
                                }
                            }
                            state.mut().disagreements = locals.mismatches;
                            state.mut().setCount = locals.count;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 disagreements;\nuint64 setCount;",
                        body: "output.disagreements = state.get().disagreements;\noutput.setCount = state.get().setCount;",
                    },
                ],
                initialize: "state.mut().bits.setAll(0);\nstate.mut().flags.setAll(0);\nstate.mut().disagreements = 0;\nstate.mut().setCount = 0;",
            });
            const steps: CallStep[] = [];
            for (const stride of [0n, 1n, 7n, 63n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(stride), invocator: 0, note: `every ${stride + 1n}th bit` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "SpacerFieldsThenArrayClear",
        family: "layout",
        solidity: "test/libsolidity/semanticTests/array/fixed_array_cleanup.sol",
        stresses: "zero-filling a fixed array bounded on both sides by scalar spacers — the clear must stop exactly at the array's edges",
        caveat: "Solidity's `delete data` becomes an explicit loop write of 0.",
        axes: ["capacity", "width", "loopShape"],
        build(axis) {
            const capacity = axis.capacity ?? 8;
            const width = widthOf(axis, "uint64");
            const source = emitContract({
                axis,
                name: "SpacerFieldsThenArrayClear",
                header: {
                    archetype: "SpacerFieldsThenArrayClear",
                    family: "layout",
                    solidity: "array/fixed_array_cleanup.sol",
                    stresses: "bounded clear between two spacers",
                    axis: `capacity=${capacity} width=${width}`,
                },
                state: `uint64 spacerBefore;\nArray<${width}, ${capacity}> data;\nuint64 spacerAfter;\nuint64 checksum;`,
                entries: [
                    {
                        name: "FillThenClear",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;\nuint64 clear;",
                        locals: "uint64 i;\nuint64 total;",
                        body: `
                            state.mut().spacerBefore = 0x3333333333333333ULL;
                            state.mut().spacerAfter = 0x4444444444444444ULL;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                state.mut().data.set(locals.i, (${width})(input.value + locals.i));
                            }
                            if (input.clear != 0)
                            {
                                for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                                {
                                    state.mut().data.set(locals.i, 0);
                                }
                            }
                            locals.total = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.total += (uint64)state.get().data.get(locals.i);
                            }
                            state.mut().checksum = locals.total;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 spacerBefore;\nuint64 spacerAfter;\nuint64 checksum;",
                        body: `
                            output.spacerBefore = state.get().spacerBefore;
                            output.spacerAfter = state.get().spacerAfter;
                            output.checksum = state.get().checksum;
                        `,
                    },
                ],
                initialize: "state.mut().data.setAll(0);\nstate.mut().spacerBefore = 0;\nstate.mut().spacerAfter = 0;\nstate.mut().checksum = 0;",
            });
            const steps: CallStep[] = [];
            for (const [value, clear] of [
                [7n, 0n],
                [7n, 1n],
                [maxOf(width), 0n],
                [maxOf(width), 1n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(value) + u64(clear), invocator: 0, note: `value ${value} clear=${clear}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "PackedUint128PairSum",
        family: "layout",
        solidity: "OpenZeppelin utils/structs/DoubleEndedQueue.sol (`uint128 _begin; uint128 _end;`)",
        stresses: "two uint128 packed side by side: wrapping one must not disturb the other, and their sum must round-trip",
        caveat: "uint128 arithmetic in QPI is add/subtract only; multiplication is left out.",
        axes: ["placement", "layout"],
        build(axis) {
            const ordered = orderFields(axis, [
                { declaration: "uint128 begin;", bytes: 16 },
                { declaration: "uint128 end;", bytes: 16 },
            ]);
            const source = emitContract({
                axis,
                name: "PackedUint128PairSum",
                header: {
                    archetype: "PackedUint128PairSum",
                    family: "layout",
                    solidity: "OpenZeppelin DoubleEndedQueue begin/end",
                    stresses: "adjacent uint128 fields",
                    axis: `layout=${axis.layout ?? "declared"}`,
                },
                prelude: `struct Cursor\n{\n${ordered
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n")}\n};`,
                state: "Cursor cursor;\nuint128 span;\nuint64 cursorSize;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Advance",
                        kind: "procedure",
                        number: 1,
                        input: "uint128 beginDelta;\nuint128 endDelta;",
                        locals: "uint128 scratch;",
                        body: `
                            state.mut().cursor.begin += input.beginDelta;
                            state.mut().cursor.end += input.endDelta;
                            locals.scratch = state.get().cursor.end - state.get().cursor.begin;
                            state.mut().span = locals.scratch;
                            state.mut().cursorSize = sizeof(Cursor);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint128 span;\nuint64 cursorSize;",
                        body: "output.span = state.get().span;\noutput.cursorSize = state.get().cursorSize;",
                    },
                ],
                initialize: "state.mut().span = 0;\nstate.mut().cursorSize = 0;",
            });
            const u128 = (value: bigint): string => {
                let hex = "";
                let raw = value & ((1n << 128n) - 1n);
                for (let i = 0; i < 16; i++) {
                    hex += (raw & 0xffn).toString(16).padStart(2, "0");
                    raw >>= 8n;
                }
                return hex;
            };
            const steps: CallStep[] = [];
            for (const [a, b] of [
                [1n, 2n],
                [(1n << 64n) - 1n, 1n],
                [1n << 64n, 1n << 64n],
                [(1n << 128n) - 1n, 1n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u128(a) + u128(b), invocator: 0, note: `begin += ${a}, end += ${b}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },
];
