// Struct layout, packing and padding.

import { emitContract } from "../emit";
import { orderFields, widthOf } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

const WRITE_READ: CallStep[] = [
    { kind: "procedure", entry: 1, in: u64(1), invocator: 0 },
    { kind: "function", entry: 1 },
    { kind: "procedure", entry: 1, in: u64(0xfedcba9876543210n), invocator: 0, note: "every byte distinct, so a shifted field is visible" },
    { kind: "function", entry: 1 },
    { kind: "procedure", entry: 1, in: u64(18446744073709551615n), invocator: 0 },
    { kind: "function", entry: 1 },
    { kind: "advanceTick", n: 1 },
];

/** A struct whose fields the `layout` axis reorders, written through and measured. Offsets are computed in-contract from the addresses of the members, so
 *  interior padding is observable rather than implied. */
function packingProbe(meta: Omit<Archetype, "build" | "axes">, fields: { declaration: string; bytes: number }[], probeField: string): Archetype {
    return {
        ...meta,
        axes: ["layout", "placement"],
        build(axis: AxisAssignment) {
            const ordered = orderFields(axis, fields);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: "layout",
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: `layout=${axis.layout ?? "declared"} placement=${axis.placement ?? "first"}`,
                },
                prelude: `struct Packed\n{\n${ordered
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n")}\n};`,
                state: "Packed packed;\nuint64 packedSize;\nuint64 stateSize;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().packed.${probeField} = input.value;
                            state.mut().packedSize = sizeof(Packed);
                            state.mut().stateSize = sizeof(StateData);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 packedSize;\nuint64 stateSize;\nuint64 probe;\nuint64 guard;",
                        body: `
                            output.packedSize = state.get().packedSize;
                            output.stateSize = state.get().stateSize;
                            output.probe = (uint64)state.get().packed.${probeField};
                            output.guard = state.get().placementGuard;
                        `,
                    },
                ],
                initialize: "state.mut().packedSize = 0;\nstate.mut().stateSize = 0;\nstate.mut().placementGuard = 0;",
            });
            return { source, script: script(WRITE_READ) };
        },
    };
}

export const LAYOUT_ARCHETYPES: Archetype[] = [
    packingProbe(
        {
            name: "PackMixedWidths",
            family: "layout",
            solidity: `${SOL}/storage/packed_storage_structs_uint.sol`,
            stresses: "a struct of four different widths, reordered by the layout axis: tail padding, interior holes and total size all move",
            caveat: "Solidity packs into 32-byte slots; the QPI port keeps the field widths and lets C++ rules place them.",
        },
        [
            { declaration: "uint64 wide;", bytes: 8 },
            { declaration: "uint32 medium;", bytes: 4 },
            { declaration: "uint16 small;", bytes: 2 },
            { declaration: "uint8 tiny;", bytes: 1 },
        ],
        "wide",
    ),
    packingProbe(
        {
            name: "PackWithIdField",
            family: "layout",
            solidity: `${SOL}/types/address_types.sol`,
            stresses: "a 32-byte id among narrow fields — the alignment case where reordering changes size the most",
        },
        [
            { declaration: "id owner;", bytes: 32 },
            { declaration: "uint64 wide;", bytes: 8 },
            { declaration: "uint8 tiny;", bytes: 1 },
        ],
        "wide",
    ),
    packingProbe(
        {
            name: "PackWithU128Field",
            family: "layout",
            solidity: `${SOL}/types/uint256_conversion.sol`,
            stresses: "a uint128 next to narrow fields — 16-byte alignment, which is where a hand-written layout pass most often disagrees with clang",
            caveat: "Stands in for Solidity's uint256; the alignment question is the same one width down.",
        },
        [
            { declaration: "uint128 huge;", bytes: 16 },
            { declaration: "uint32 medium;", bytes: 4 },
            { declaration: "uint8 tiny;", bytes: 1 },
        ],
        "medium",
    ),
    packingProbe(
        {
            name: "PackWithBitField",
            family: "layout",
            solidity: `${SOL}/storage/packed_storage_structs_bytes.sol`,
            stresses: "QPI's `bit` (a char wrapper, not a bool) adjacent to wide fields",
        },
        [
            { declaration: "uint64 wide;", bytes: 8 },
            { declaration: "bit flag;", bytes: 1 },
            { declaration: "uint32 medium;", bytes: 4 },
        ],
        "wide",
    ),

    {
        name: "StructCopyWholeAssign",
        family: "layout",
        solidity: `${SOL}/structs/struct_copy.sol`,
        stresses: "assigning a whole nested struct — the padding bytes the copy does or does not carry, which K12 over the state sees",
        caveat: "Solidity's `data[to] = data[from]` on a storage struct; the QPI form copies through a `_locals` member.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "StructCopyWholeAssign",
                header: {
                    archetype: "StructCopyWholeAssign",
                    family: "layout",
                    solidity: `${SOL}/structs/struct_copy.sol`,
                    stresses: "whole-struct assignment including padding",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                prelude: "struct Nested\n{\n    uint64 x;\n    uint64 y;\n};\n\nstruct Holder\n{\n    uint64 a;\n    Nested nested;\n    uint8 tag;\n};",
                state: "Holder source;\nHolder target;\nuint64 holderSize;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "SetAndCopy",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "Holder scratch;",
                        body: `
                            state.mut().source.a = input.value;
                            state.mut().source.nested.x = input.value + 3;
                            state.mut().source.nested.y = input.value + 4;
                            state.mut().source.tag = (uint8)input.value;
                            locals.scratch = state.get().source;
                            state.mut().target = locals.scratch;
                            state.mut().holderSize = sizeof(Holder);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 a;\nuint64 x;\nuint64 y;\nuint64 tag;\nuint64 holderSize;",
                        body: `
                            output.a = state.get().target.a;
                            output.x = state.get().target.nested.x;
                            output.y = state.get().target.nested.y;
                            output.tag = (uint64)state.get().target.tag;
                            output.holderSize = state.get().holderSize;
                        `,
                    },
                ],
                initialize: "state.mut().holderSize = 0;",
            });
            return { source, script: script(WRITE_READ) };
        },
    },

    {
        name: "ArrayOfStructsStride",
        family: "layout",
        solidity: `${SOL}/array/array_of_structs.sol`,
        stresses: "the stride of an Array<Struct, N> — an element size that disagrees writes into the neighbour",
        axes: ["capacity", "layout"],
        build(axis) {
            const capacity = axis.capacity ?? 8;
            const ordered = orderFields(axis, [
                { declaration: "uint64 wide;", bytes: 8 },
                { declaration: "uint16 small;", bytes: 2 },
                { declaration: "uint8 tiny;", bytes: 1 },
            ]);
            const source = emitContract({
                axis,
                name: "ArrayOfStructsStride",
                header: {
                    archetype: "ArrayOfStructsStride",
                    family: "layout",
                    solidity: `${SOL}/array/array_of_structs.sol`,
                    stresses: "element stride of an array of structs",
                    axis: `capacity=${capacity} layout=${axis.layout ?? "declared"}`,
                },
                prelude: `struct Element\n{\n${ordered
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n")}\n};`,
                state: `Array<Element, ${capacity}> elements;\nuint64 elementSize;\nuint64 checksum;`,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: `uint64 i;\nElement scratch;\nuint64 total;`,
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.scratch.wide = locals.i + 1;
                                locals.scratch.small = (uint16)(locals.i + 2);
                                locals.scratch.tiny = (uint8)(locals.i + 3);
                                state.mut().elements.set(locals.i, locals.scratch);
                            }
                            locals.total = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.total += state.get().elements.get(locals.i).wide;
                                locals.total += (uint64)state.get().elements.get(locals.i).small;
                                locals.total += (uint64)state.get().elements.get(locals.i).tiny;
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
                initialize: "state.mut().elementSize = 0;\nstate.mut().checksum = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(1), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(capacity), invocator: 0, note: "exactly full" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(capacity + 3), invocator: 0, note: "past capacity — Array::get masks, so this wraps" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "EnumUnderlyingWidth",
        family: "layout",
        solidity: `${SOL}/enums/enum_with_underlying_type.sol`,
        stresses: "an enum's storage width when it is spelled explicitly, left implicit, or reached through an alias",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EnumUnderlyingWidth",
                header: {
                    archetype: "EnumUnderlyingWidth",
                    family: "layout",
                    solidity: `${SOL}/enums/enum_with_underlying_type.sol`,
                    stresses: "explicit, implicit and aliased enum underlying types side by side",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                prelude: [
                    "enum Implicit { A = 0, B = 1, C = 2 };",
                    "enum Explicit : uint8 { D = 0, E = 1, F = 2 };",
                    "enum Wide : uint64 { G = 0, H = 1, I = 2 };",
                    "using AliasedWide = Wide;",
                ].join("\n"),
                state: "Implicit implicitValue;\nExplicit explicitValue;\nAliasedWide aliasedValue;\nuint64 implicitSize;\nuint64 explicitSize;\nuint64 aliasedSize;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Set",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 slot;",
                        body: `
                            locals.slot = QPI::mod(input.value, 3ULL);
                            state.mut().implicitValue = (Implicit)locals.slot;
                            state.mut().explicitValue = (Explicit)locals.slot;
                            state.mut().aliasedValue = (AliasedWide)locals.slot;
                            state.mut().implicitSize = sizeof(Implicit);
                            state.mut().explicitSize = sizeof(Explicit);
                            state.mut().aliasedSize = sizeof(AliasedWide);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 implicitSize;\nuint64 explicitSize;\nuint64 aliasedSize;\nuint64 observed;",
                        body: `
                            output.implicitSize = state.get().implicitSize;
                            output.explicitSize = state.get().explicitSize;
                            output.aliasedSize = state.get().aliasedSize;
                            output.observed = (uint64)state.get().aliasedValue;
                        `,
                    },
                ],
                initialize: "state.mut().implicitSize = 0;\nstate.mut().explicitSize = 0;\nstate.mut().aliasedSize = 0;",
            });
            return { source, script: script(WRITE_READ) };
        },
    },

    {
        name: "SelfDescribingOffsets",
        family: "layout",
        solidity: "layout oracle (no direct Solidity origin)",
        stresses: "the contract measures its own member offsets and writes them into state, so any layout disagreement is a first-byte digest difference",
        caveat: "Deliberately not a Solidity port: this is the strongest layout oracle available inside the contract itself.",
        axes: ["layout", "width"],
        build(axis) {
            const width = widthOf(axis, "uint32");
            const ordered = orderFields(axis, [
                { declaration: "uint64 first;", bytes: 8 },
                { declaration: `${width} middle;`, bytes: 4 },
                { declaration: "uint8 last;", bytes: 1 },
            ]);
            const source = emitContract({
                axis,
                name: "SelfDescribingOffsets",
                header: {
                    archetype: "SelfDescribingOffsets",
                    family: "layout",
                    solidity: "layout oracle",
                    stresses: "in-contract sizeof of every member and of the whole struct",
                    axis: `layout=${axis.layout ?? "declared"} width=${width}`,
                },
                prelude: `struct Probe\n{\n${ordered
                    .split("\n")
                    .map((line) => `    ${line}`)
                    .join("\n")}\n};`,
                state: "Probe probe;\nuint64 wholeSize;\nuint64 firstSize;\nuint64 middleSize;\nuint64 lastSize;",
                entries: [
                    {
                        name: "Measure",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().probe.first = input.value;
                            state.mut().probe.middle = (${width})input.value;
                            state.mut().probe.last = (uint8)input.value;
                            state.mut().wholeSize = sizeof(Probe);
                            state.mut().firstSize = sizeof(state.get().probe.first);
                            state.mut().middleSize = sizeof(state.get().probe.middle);
                            state.mut().lastSize = sizeof(state.get().probe.last);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 wholeSize;\nuint64 firstSize;\nuint64 middleSize;\nuint64 lastSize;",
                        body: `
                            output.wholeSize = state.get().wholeSize;
                            output.firstSize = state.get().firstSize;
                            output.middleSize = state.get().middleSize;
                            output.lastSize = state.get().lastSize;
                        `,
                    },
                ],
                initialize: "state.mut().wholeSize = 0;\nstate.mut().firstSize = 0;\nstate.mut().middleSize = 0;\nstate.mut().lastSize = 0;",
            });
            return { source, script: script(WRITE_READ) };
        },
    },
];
