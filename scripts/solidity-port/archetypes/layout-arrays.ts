// Multi-dimensional arrays and the padding around them.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/array";

/** Drive a (row, column, value) ladder and read after each. */
function grid(cells: [bigint, bigint, bigint][]): CallStep[] {
    const steps: CallStep[] = [];
    for (const [row, column, value] of cells) {
        steps.push({ kind: "procedure", entry: 1, in: u64(row) + u64(column) + u64(value), invocator: 0, note: `(${row}, ${column}) = ${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const LAYOUT_ARRAY_ARCHETYPES: Archetype[] = [
    {
        name: "ArrayOfArraysStride",
        family: "layout",
        solidity: `${SOL}/fixed_arrays_in_storage.sol`,
        stresses:
            "an Array of Arrays indexed on both axes — the outer stride is the whole inner array, so an element-sized stride would still read a plausible value",
        caveat: "Solidity packs storage arrays by slot; a QPI Array of Arrays is a plain C++ nesting, so only the indexing shape is comparable.",
        axes: ["capacity", "placement"],
        build(axis) {
            const inner = Math.min(8, capacityOf(axis, 8));
            const outer = 4;
            const source = emitContract({
                axis,
                name: "ArrayOfArraysStride",
                header: {
                    archetype: "ArrayOfArraysStride",
                    family: "layout",
                    solidity: `${SOL}/fixed_arrays_in_storage.sol`,
                    stresses: "two-axis indexing over a nested Array",
                    caveat: "no slot packing — the nesting is plain C++",
                    axis: `outer=${outer} inner=${inner}`,
                },
                state: `Array<Array<uint64, ${inner}>, ${outer}> grid;\nuint64 canary;\nuint64 writes;`,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 row;\nuint64 column;\nuint64 value;",
                        locals: `Array<uint64, ${inner}> line;`,
                        body: `
                            locals.line = state.get().grid.get(input.row);
                            locals.line.set(input.column, input.value);
                            state.mut().grid.set(input.row, locals.line);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 row;\nuint64 column;",
                        output: "uint64 value;\nuint64 rowStart;\nuint64 rowEnd;\nuint64 canary;\nuint64 writes;",
                        body: `
                            output.value = state.get().grid.get(input.row).get(input.column);
                            output.rowStart = state.get().grid.get(input.row).get(0);
                            output.rowEnd = state.get().grid.get(input.row).get(${inner - 1});
                            output.canary = state.get().canary;
                            output.writes = state.get().writes;
                        `,
                    },
                ],
                initializeLocals: `uint64 i;\nArray<uint64, ${inner}> line;`,
                initialize: `
                    state.mut().canary = 18446744073709551615ULL;
                    state.mut().writes = 0;
                    locals.line.setAll(0);
                    for (locals.i = 0; locals.i < ${outer}; locals.i++)
                    {
                        state.mut().grid.set(locals.i, locals.line);
                    }
                `,
            });
            const steps: CallStep[] = [];
            for (const [row, column, value] of [
                [0n, 0n, 11n],
                [0n, BigInt(inner - 1), 12n],
                [BigInt(outer - 1), 0n, 13n],
                [BigInt(outer - 1), BigInt(inner - 1), 14n],
                [BigInt(outer), 0n, 15n],
                [0n, BigInt(inner), 16n],
            ] as [bigint, bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(row) + u64(column) + u64(value), invocator: 0, note: `(${row}, ${column}) = ${value}` });
                steps.push({ kind: "function", entry: 1, in: u64(row) + u64(column) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "ThreeDimArrayStride",
        family: "layout",
        solidity: `${SOL}/multidim_array.sol`,
        stresses:
            "three nested Arrays, written at the far corner — the innermost stride, the middle stride and the outer stride all have to be right for the corner to be the corner",
        caveat: "As above: only the indexing shape is comparable, not Solidity's storage encoding.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "ThreeDimArrayStride",
                header: {
                    archetype: "ThreeDimArrayStride",
                    family: "layout",
                    solidity: `${SOL}/multidim_array.sol`,
                    stresses: "three-axis indexing and the corner element",
                    caveat: "no slot packing",
                    axis: "2x4x8 nesting",
                },
                state: "Array<Array<Array<uint32, 8>, 4>, 2> cube;\nuint64 guardBefore;\nuint64 guardAfter;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 x;\nuint64 y;\nuint64 z;\nuint32 value;",
                        locals: "Array<Array<uint32, 8>, 4> plane;\nArray<uint32, 8> line;",
                        body: `
                            locals.plane = state.get().cube.get(input.x);
                            locals.line = locals.plane.get(input.y);
                            locals.line.set(input.z, input.value);
                            locals.plane.set(input.y, locals.line);
                            state.mut().cube.set(input.x, locals.plane);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 x;\nuint64 y;\nuint64 z;",
                        output: "uint32 value;\nuint32 origin;\nuint32 corner;\nuint64 guardBefore;\nuint64 guardAfter;",
                        body: `
                            output.value = state.get().cube.get(input.x).get(input.y).get(input.z);
                            output.origin = state.get().cube.get(0).get(0).get(0);
                            output.corner = state.get().cube.get(1).get(3).get(7);
                            output.guardBefore = state.get().guardBefore;
                            output.guardAfter = state.get().guardAfter;
                        `,
                    },
                ],
                initializeLocals: "uint64 i;\nuint64 j;\nArray<Array<uint32, 8>, 4> plane;\nArray<uint32, 8> line;",
                initialize: `
                    state.mut().guardBefore = 12297829382473034410ULL;
                    state.mut().guardAfter = 14757395258967641292ULL;
                    state.mut().writes = 0;
                    locals.line.setAll(0);
                    for (locals.j = 0; locals.j < 4; locals.j++)
                    {
                        locals.plane.set(locals.j, locals.line);
                    }
                    for (locals.i = 0; locals.i < 2; locals.i++)
                    {
                        state.mut().cube.set(locals.i, locals.plane);
                    }
                `,
            });
            const steps: CallStep[] = [];
            for (const [x, y, z, value] of [
                [0n, 0n, 0n, 1n],
                [1n, 3n, 7n, 2n],
                [0n, 3n, 7n, 3n],
                [1n, 0n, 0n, 4n],
                [2n, 4n, 8n, 5n],
            ] as [bigint, bigint, bigint, bigint][]) {
                steps.push({
                    kind: "procedure",
                    entry: 1,
                    in: u64(x) + u64(y) + u64(z) + Number(value).toString(16).padStart(8, "0").match(/../g)!.reverse().join(""),
                    invocator: 0,
                    note: `(${x}, ${y}, ${z}) = ${value}`,
                });
                steps.push({ kind: "function", entry: 1, in: u64(x) + u64(y) + u64(z) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "StructWithTrailingBitArray",
        family: "layout",
        solidity: `${SOL}/../structs/struct_packing.sol`,
        stresses:
            "a BitArray as the last member of a struct that is itself an array element — the element's size has to round up past the bit array, or the stride is short",
        caveat: "Solidity has no bit array type; the original packs bools into a slot, which is the same question asked of a different layout rule.",
        axes: ["capacity", "placement", "layout"],
        build(axis) {
            const capacity = Math.min(8, capacityOf(axis, 8));
            const source = emitContract({
                axis,
                name: "StructWithTrailingBitArray",
                header: {
                    archetype: "StructWithTrailingBitArray",
                    family: "layout",
                    solidity: "structs/struct_packing.sol",
                    stresses: "element stride over a struct ending in a BitArray",
                    caveat: "packed bools become a BitArray",
                    axis: `capacity=${capacity}`,
                },
                prelude: "struct Entry\n{\n    uint64 amount;\n    uint16 tag;\n    BitArray<64> flags;\n    uint8 kind;\n};",
                state: `Array<Entry, ${capacity}> entries;\nuint64 canary;\nuint64 writes;`,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;\nuint64 amount;\nuint64 bit;",
                        locals: "Entry entry;",
                        body: `
                            locals.entry = state.get().entries.get(input.index);
                            locals.entry.amount = input.amount;
                            locals.entry.tag = (uint16)input.bit;
                            locals.entry.kind = (uint8)QPI::mod(input.amount, 251ULL);
                            locals.entry.flags.set(input.bit, 1);
                            state.mut().entries.set(input.index, locals.entry);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "uint64 index;",
                        output: "uint64 amount;\nuint16 tag;\nuint8 kind;\nuint64 bitZero;\nuint64 bit63;\nuint64 neighbourAmount;\nuint64 canary;",
                        body: `
                            output.amount = state.get().entries.get(input.index).amount;
                            output.tag = state.get().entries.get(input.index).tag;
                            output.kind = state.get().entries.get(input.index).kind;
                            output.bitZero = state.get().entries.get(input.index).flags.get(0);
                            output.bit63 = state.get().entries.get(input.index).flags.get(63);
                            output.neighbourAmount = state.get().entries.get(input.index + 1).amount;
                            output.canary = state.get().canary;
                        `,
                    },
                ],
                initializeLocals: "uint64 i;\nEntry entry;",
                initialize: `
                    state.mut().canary = 18446744073709551615ULL;
                    state.mut().writes = 0;
                    locals.entry.amount = 0;
                    locals.entry.tag = 0;
                    locals.entry.kind = 0;
                    locals.entry.flags.setAll(0);
                    for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                    {
                        state.mut().entries.set(locals.i, locals.entry);
                    }
                `,
            });
            const steps: CallStep[] = [];
            for (const [index, amount, bit] of [
                [0n, 111n, 0n],
                [0n, 222n, 63n],
                [BigInt(capacity - 1), 333n, 1n],
                [BigInt(capacity), 444n, 64n],
            ] as [bigint, bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(index) + u64(amount) + u64(bit), invocator: 0, note: `entry ${index}` });
                steps.push({ kind: "function", entry: 1, in: u64(index) });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "PackingTwentyFourEight",
        family: "layout",
        solidity: "structs/struct_packing.sol",
        stresses:
            "an id (32 bytes), a uint32 and a uint64 in every declaration order — the alignment of the widest member decides where the other two land and how much tail padding the struct carries",
        caveat: "Solidity packs a struct into 32-byte slots; C++ aligns each member to its own width, so the two languages disagree by construction. Only the two Qubic backends have to agree.",
        axes: ["layout", "placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "PackingTwentyFourEight",
                header: {
                    archetype: "PackingTwentyFourEight",
                    family: "layout",
                    solidity: "structs/struct_packing.sol",
                    stresses: "id + uint32 + uint64 in one struct, with a canary either side",
                    caveat: "C++ alignment, not Solidity slot packing",
                    axis: "id/uint32/uint64 packing",
                },
                prelude:
                    "struct Record\n{\n    id who;\n    uint32 small;\n    uint64 large;\n};\n\nstruct Reordered\n{\n    uint32 small;\n    uint64 large;\n    id who;\n};",
                state: "uint64 canaryBefore;\nRecord straight;\nReordered reordered;\nuint64 canaryAfter;\nuint64 sizesAgree;\nuint64 writes;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint32 small;\nuint64 large;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().straight.who = qpi.invocator();
                            state.mut().straight.small = input.small;
                            state.mut().straight.large = input.large;
                            state.mut().reordered.who = qpi.invocator();
                            state.mut().reordered.small = input.small;
                            state.mut().reordered.large = input.large;
                            locals.scratch = sizeof(Record) == sizeof(Reordered) ? 1 : 0;
                            state.mut().sizesAgree = locals.scratch;
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint32 straightSmall;\nuint64 straightLarge;\nuint32 reorderedSmall;\nuint64 reorderedLarge;\nuint64 canaryBefore;\nuint64 canaryAfter;\nuint64 sizesAgree;\nuint64 recordSize;\nuint64 reorderedSize;",
                        body: `
                            output.straightSmall = state.get().straight.small;
                            output.straightLarge = state.get().straight.large;
                            output.reorderedSmall = state.get().reordered.small;
                            output.reorderedLarge = state.get().reordered.large;
                            output.canaryBefore = state.get().canaryBefore;
                            output.canaryAfter = state.get().canaryAfter;
                            output.sizesAgree = state.get().sizesAgree;
                            output.recordSize = sizeof(Record);
                            output.reorderedSize = sizeof(Reordered);
                        `,
                    },
                ],
                initialize: `
                    state.mut().canaryBefore = 12297829382473034410ULL;
                    state.mut().canaryAfter = 14757395258967641292ULL;
                    state.mut().straight.small = 0;
                    state.mut().straight.large = 0;
                    state.mut().reordered.small = 0;
                    state.mut().reordered.large = 0;
                    state.mut().sizesAgree = 0;
                    state.mut().writes = 0;
                `,
            });
            const steps: CallStep[] = [];
            for (const [small, large] of [
                [0n, 0n],
                [4294967295n, 18446744073709551615n],
                [1n, 2n],
            ] as [bigint, bigint][]) {
                steps.push({
                    kind: "procedure",
                    entry: 1,
                    // uint32 then four bytes of padding before the uint64.
                    in: Number(small).toString(16).padStart(8, "0").match(/../g)!.reverse().join("") + "00000000" + u64(large),
                    invocator: 0,
                    note: `small=${small} large=${large}`,
                });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "GridRowMajorVersusColumnMajor",
        family: "layout",
        solidity: `${SOL}/multidim_array.sol`,
        stresses:
            "the same logical grid stored as rows of columns and as one flat array indexed by hand — the two must stay identical cell by cell, which is only true if the stride arithmetic matches the nesting",
        axes: ["capacity", "placement", "loopShape"],
        build(axis) {
            const side = 4;
            const source = emitContract({
                axis,
                name: "GridRowMajorVersusColumnMajor",
                header: {
                    archetype: "GridRowMajorVersusColumnMajor",
                    family: "layout",
                    solidity: `${SOL}/multidim_array.sol`,
                    stresses: "nested indexing against hand-computed flat indexing",
                    axis: `${side}x${side} grid`,
                },
                state: `Array<Array<uint64, ${side}>, ${side}> nested;\nArray<uint64, ${side * side}> flat;\nuint64 mismatches;\nuint64 writes;`,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 row;\nuint64 column;\nuint64 value;",
                        locals: `Array<uint64, ${side}> line;\nuint64 i;\nuint64 j;`,
                        body: `
                            locals.line = state.get().nested.get(input.row);
                            locals.line.set(input.column, input.value);
                            state.mut().nested.set(input.row, locals.line);
                            state.mut().flat.set(input.row * ${side} + input.column, input.value);
                            for (locals.i = 0; locals.i < ${side}; locals.i++)
                            {
                                for (locals.j = 0; locals.j < ${side}; locals.j++)
                                {
                                    if (state.get().nested.get(locals.i).get(locals.j) != state.get().flat.get(locals.i * ${side} + locals.j))
                                    {
                                        state.mut().mismatches++;
                                    }
                                }
                            }
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 mismatches;\nuint64 writes;\nuint64 firstCell;\nuint64 lastCell;",
                        body: `
                            output.mismatches = state.get().mismatches;
                            output.writes = state.get().writes;
                            output.firstCell = state.get().nested.get(0).get(0);
                            output.lastCell = state.get().flat.get(${side * side - 1});
                        `,
                    },
                ],
                initializeLocals: `uint64 i;\nArray<uint64, ${side}> line;`,
                initialize: `
                    state.mut().flat.setAll(0);
                    state.mut().mismatches = 0;
                    state.mut().writes = 0;
                    locals.line.setAll(0);
                    for (locals.i = 0; locals.i < ${side}; locals.i++)
                    {
                        state.mut().nested.set(locals.i, locals.line);
                    }
                `,
            });
            return {
                source,
                script: script(
                    grid([
                        [0n, 0n, 1n],
                        [1n, 2n, 22n],
                        [3n, 3n, 33n],
                        [4n, 0n, 44n],
                        [0n, 4n, 55n],
                    ]),
                ),
            };
        },
    },
];
