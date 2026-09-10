// Namespace, alias and shadowing archetypes.
//
// Solidity has no namespaces; these are ported from `library` declarations, `using L for T`, duplicate
// library type names, and SWC-119 shadowing. The family is first because the repo's own testing notes
// record that it "produced nine silent bugs" — including a contract whose `constexpr sint64 NULL_INDEX`
// silently rewrote qpi.h's HashMap internals, and a namespaced typedef that came out `sizeof` 2 instead
// of 24 with every self-consistency check still passing.
//
// Each archetype writes `sizeof` and member offsets into state, so a mis-resolved name changes the
// state digest instead of being absorbed silently. Every one of them carries a plain, unqualified
// control row, because the fix for a qualified-name bug has previously broken the unqualified path.

import { emitContract } from "../emit";
import { qualifiedStruct } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

/** Every layout probe reads the same three numbers back, so one output shape serves the whole family. */
const PROBE_OUTPUT = "uint64 qualifiedSize;\nuint64 plainSize;\nuint64 payload;";

const PROBE_STEPS: CallStep[] = [
    { kind: "procedure", entry: 1, in: u64(7), invocator: 0, note: "write through the qualified spelling" },
    { kind: "function", entry: 1 },
    { kind: "procedure", entry: 1, in: u64(0xdeadbeefn), invocator: 0, note: "a value whose truncation would be visible" },
    { kind: "function", entry: 1 },
    { kind: "advanceTick", n: 1 },
];

/**
 * The workhorse: one struct declared under the `ns` axis's spelling, stored in state, and measured.
 * The twin under `collision` has a deliberately different layout, so resolving to the wrong one moves
 * `sizeof` and every offset after it.
 */
function layoutProbe(meta: Omit<Archetype, "build" | "axes">, definition: string, decoy: string, payloadField: string): Archetype {
    return {
        ...meta,
        axes: ["ns", "placement"],
        build(axis: AxisAssignment) {
            const type = qualifiedStruct(axis, "Entry", definition, decoy);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: "namespaces",
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: `ns=${axis.ns ?? "global"}${axis.placement ? ` placement=${axis.placement}` : ""}`,
                },
                // The plain global struct is the control: it must keep its own size when the qualified
                // spelling is fixed, which is the row that caught a shared-fallback regression before.
                prelude: `${type.prelude}\n\nstruct PlainEntry\n{\n${definition
                    .trim()
                    .split("\n")
                    .map((line) => `    ${line.trim()}`)
                    .join("\n")}\n};`,
                state: `
                    ${type.use} qualified;
                    PlainEntry plain;
                    uint64 qualifiedSize;
                    uint64 plainSize;
                `,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().qualified.${payloadField} = input.value;
                            state.mut().plain.${payloadField} = input.value;
                            state.mut().qualifiedSize = sizeof(${type.use});
                            state.mut().plainSize = sizeof(PlainEntry);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: PROBE_OUTPUT,
                        body: `
                            output.qualifiedSize = state.get().qualifiedSize;
                            output.plainSize = state.get().plainSize;
                            output.payload = (uint64)state.get().qualified.${payloadField};
                        `,
                    },
                ],
                initialize: "state.mut().qualifiedSize = 0;\nstate.mut().plainSize = 0;",
            });
            return { source, script: script(PROBE_STEPS) };
        },
    };
}

export const NAMESPACE_ARCHETYPES: Archetype[] = [
    layoutProbe(
        {
            name: "NsTwinStruct",
            family: "namespaces",
            solidity: `${SOL}/libraries/library_struct.sol`,
            stresses: "two namespaces declaring the same struct name with different layouts; only the qualification picks the right one",
            caveat: "Solidity libraries stand in for namespaces; the collision is expressible in C++ and not in Solidity.",
        },
        "uint64 wide;\nuint32 narrow;\nuint8 tag;",
        // The decoy is deliberately smaller and differently ordered: resolving to it moves sizeof.
        "uint8 tag;",
        "wide",
    ),
    layoutProbe(
        {
            name: "NsTwinNestedStruct",
            family: "namespaces",
            solidity: `${SOL}/structs/struct_copy.sol`,
            stresses: "a namespaced struct that itself contains a struct — the nesting depth a mis-resolution changes",
        },
        "uint64 wide;\nuint64 second;\nuint32 narrow;",
        "uint16 narrow;",
        "wide",
    ),
    layoutProbe(
        {
            name: "NsTwinWithIdField",
            family: "namespaces",
            solidity: `${SOL}/types/address_types.sol`,
            stresses: "a namespaced struct carrying a 32-byte id, where a wrong resolution changes alignment as well as size",
        },
        "id owner;\nuint64 wide;",
        "uint8 wide;",
        "wide",
    ),

    {
        name: "NsInheritedNamespacedTypedef",
        family: "namespaces",
        solidity: `${SOL}/inheritance/inherited_type.sol`,
        stresses: "a state field typed by a namespaced typedef reached through inheritance — the shape that came out sizeof 2 instead of 24",
        caveat: "Solidity's inherited library type; the QPI form is a namespaced typedef used as a base for the state member's type.",
        axes: ["ns"],
        build(axis) {
            const type = qualifiedStruct(axis, "Base", "uint64 a;\nuint64 b;\nuint64 c;", "uint16 a;");
            const source = emitContract({
                axis,
                name: "NsInheritedNamespacedTypedef",
                header: {
                    archetype: "NsInheritedNamespacedTypedef",
                    family: "namespaces",
                    solidity: `${SOL}/inheritance/inherited_type.sol`,
                    stresses: "sizeof of a struct inheriting from a namespaced typedef",
                    caveat: "the historical failure returned 2 for a 24-byte type while every self-consistency check passed",
                    axis: `ns=${axis.ns ?? "global"}`,
                },
                prelude: `${type.prelude}\n\nstruct Derived : public ${type.use}\n{\n    uint64 d;\n};`,
                state: "Derived derived;\nuint64 derivedSize;\nuint64 baseSize;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().derived.a = input.value;
                            state.mut().derived.d = input.value + 1;
                            state.mut().derivedSize = sizeof(Derived);
                            state.mut().baseSize = sizeof(${type.use});
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 derivedSize;\nuint64 baseSize;\nuint64 a;\nuint64 d;",
                        body: `
                            output.derivedSize = state.get().derivedSize;
                            output.baseSize = state.get().baseSize;
                            output.a = (uint64)state.get().derived.a;
                            output.d = state.get().derived.d;
                        `,
                    },
                ],
                initialize: "state.mut().derivedSize = 0;\nstate.mut().baseSize = 0;",
            });
            return { source, script: script(PROBE_STEPS) };
        },
    },

    {
        name: "NsTwinConstant",
        family: "namespaces",
        solidity: `${SOL}/constants/constant_variables.sol`,
        stresses: "two namespaces declaring the same constant, each used as a container capacity; the wrong one silently resizes the container",
        caveat: "Solidity library constants; in QPI a capacity constant is a static_assert'd power of two, so a wrong pick changes the state layout.",
        axes: ["ns"],
        build(axis) {
            const collision = (axis.ns ?? "global") === "collision";
            const prelude = collision
                ? "namespace Alpha\n{\nstatic constexpr uint64 CAPACITY = 8;\n}\n\nnamespace Beta\n{\nstatic constexpr uint64 CAPACITY = 64;\n}"
                : "namespace Alpha\n{\nstatic constexpr uint64 CAPACITY = 8;\n}";
            const use = "Alpha::CAPACITY";
            const source = emitContract({
                axis,
                name: "NsTwinConstant",
                header: {
                    archetype: "NsTwinConstant",
                    family: "namespaces",
                    solidity: `${SOL}/constants/constant_variables.sol`,
                    stresses: "a namespaced capacity constant with a same-named twin of a different value",
                    axis: `ns=${axis.ns ?? "global"}`,
                },
                prelude,
                state: `Array<uint64, ${use}> slots;\nuint64 capacity;\nuint64 checksum;`,
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nuint64 total;",
                        body: `
                            state.mut().capacity = ${use};
                            locals.total = 0;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                state.mut().slots.set(locals.i, locals.i + 1);
                            }
                            for (locals.i = 0; locals.i < ${use}; locals.i++)
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
                        output: "uint64 capacity;\nuint64 checksum;",
                        body: "output.capacity = state.get().capacity;\noutput.checksum = state.get().checksum;",
                    },
                ],
                initialize: "state.mut().slots.setAll(0);\nstate.mut().capacity = 0;\nstate.mut().checksum = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(4), invocator: 0, note: "half fill" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(8), invocator: 0, note: "fill to the smaller capacity" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(64), invocator: 0, note: "past the smaller capacity — Array masks, so this wraps" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "NsTwinEnum",
        family: "namespaces",
        solidity: `${SOL}/enums/enum_explicit_overflow.sol`,
        stresses: "two namespaces declaring the same enum with different underlying widths — the enumerator value survives, the storage width does not",
        axes: ["ns"],
        build(axis) {
            const collision = (axis.ns ?? "global") === "collision";
            const prelude = collision
                ? "namespace Alpha\n{\nenum Status : uint64 { Idle = 0, Busy = 1, Done = 2 };\n}\n\nnamespace Beta\n{\nenum Status : uint8 { Idle = 0, Busy = 1, Done = 2 };\n}"
                : "namespace Alpha\n{\nenum Status : uint64 { Idle = 0, Busy = 1, Done = 2 };\n}";
            const source = emitContract({
                axis,
                name: "NsTwinEnum",
                header: {
                    archetype: "NsTwinEnum",
                    family: "namespaces",
                    solidity: `${SOL}/enums/enum_explicit_overflow.sol`,
                    stresses: "namespaced enum underlying width",
                    axis: `ns=${axis.ns ?? "global"}`,
                },
                prelude,
                state: "Alpha::Status status;\nuint64 statusSize;\nuint64 observed;",
                entries: [
                    {
                        name: "Advance",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().status = (Alpha::Status)QPI::mod(input.value, 3ULL);
                            state.mut().statusSize = sizeof(Alpha::Status);
                            state.mut().observed = (uint64)state.get().status;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 statusSize;\nuint64 observed;",
                        body: "output.statusSize = state.get().statusSize;\noutput.observed = state.get().observed;",
                    },
                ],
                initialize: "state.mut().statusSize = 0;\nstate.mut().observed = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(2), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(7), invocator: 0, note: "mod 3 wraps to 1" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "NsConstantShadowsQpiInternal",
        family: "namespaces",
        solidity: "not-so-smart-contracts/incorrect_interface (name-collision family)",
        stresses: "a contract-level constant named exactly like a qpi.h internal, which previously rewrote HashMap's internals silently",
        caveat: "No Solidity analogue — this is the historical Qubic bug, reproduced across several qpi.h-internal names.",
        axes: [],
        build(axis) {
            // The names below are qpi.h internals a contract can legally declare; the point is that
            // declaring them must not change the behaviour of the containers that use the real ones.
            const source = emitContract({
                axis,
                name: "NsConstantShadowsQpiInternal",
                header: {
                    archetype: "NsConstantShadowsQpiInternal",
                    family: "namespaces",
                    solidity: "Qubic-specific: the historical NULL_INDEX HashMap corruption",
                    stresses: "contract-scope constants colliding with qpi.h internal names, next to a live HashMap",
                    axis: "base",
                },
                state: "HashMap<uint64, uint64, 8> book;\nuint64 population;\nuint64 fetched;\nuint64 shadowed;",
                entries: [
                    {
                        name: "Churn",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nuint64 value;",
                        locals: "uint64 seen;",
                        body: `
                            state.mut().book.set(input.key, input.value);
                            locals.seen = 0;
                            state.get().book.get(input.key, locals.seen);
                            state.mut().fetched = locals.seen;
                            state.mut().population = state.get().book.population();
                            state.mut().shadowed = NULL_INDEX_LOCAL;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 population;\nuint64 fetched;\nuint64 shadowed;",
                        body: `
                            output.population = state.get().population;
                            output.fetched = state.get().fetched;
                            output.shadowed = state.get().shadowed;
                        `,
                    },
                ],
                prelude: "static constexpr sint64 NULL_INDEX_LOCAL = 999;\nstatic constexpr uint64 EMPTY_LOCAL = 7;",
                initialize: "state.mut().book.reset();\nstate.mut().population = 0;\nstate.mut().fetched = 0;\nstate.mut().shadowed = 0;",
            });
            const steps: CallStep[] = [];
            for (const [key, value] of [
                [1n, 100n],
                [2n, 200n],
                [1n, 300n],
                [9n, 400n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(key) + u64(value), invocator: 0, note: `set ${key} -> ${value}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "NsLocalShadowsStateField",
        family: "namespaces",
        solidity: `${SOL}/scoping/scoping_local_variables.sol`,
        stresses: "a `_locals` member named exactly like a state member — the read must resolve to the local, the write to state",
        caveat: "Solidity's SWC-119 shadowing; QPI has no stack locals, so the shadow lives in the `_locals` struct.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsLocalShadowsStateField",
                header: {
                    archetype: "NsLocalShadowsStateField",
                    family: "namespaces",
                    solidity: `${SOL}/scoping/scoping_local_variables.sol`,
                    stresses: "a locals member shadowing a state member name",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 total;\nuint64 counter;\nuint64 witness;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Bump",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 delta;",
                        // `total` and `counter` deliberately repeat the state member names.
                        locals: "uint64 total;\nuint64 counter;",
                        body: `
                            locals.total = state.get().total + input.delta;
                            locals.counter = state.get().counter + 1;
                            state.mut().total = locals.total;
                            state.mut().counter = locals.counter;
                            state.mut().witness = locals.total + locals.counter;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 total;\nuint64 counter;\nuint64 witness;",
                        body: `
                            output.total = state.get().total;
                            output.counter = state.get().counter;
                            output.witness = state.get().witness;
                        `,
                    },
                ],
                initialize: "state.mut().total = 0;\nstate.mut().counter = 0;\nstate.mut().witness = 0;",
            });
            const steps: CallStep[] = [];
            for (const delta of [1n, 5n, 0n, 18446744073709551615n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(delta), invocator: 0, note: `delta ${delta}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "NsNestedNamespaceDepth",
        family: "namespaces",
        solidity: `${SOL}/libraries/library_inheritance.sol`,
        stresses: "a state field typed `A::B::C::Entry`, three namespaces deep, with a same-named type at each level",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsNestedNamespaceDepth",
                header: {
                    archetype: "NsNestedNamespaceDepth",
                    family: "namespaces",
                    solidity: `${SOL}/libraries/library_inheritance.sol`,
                    stresses: "three-deep namespace qualification with a same-named type at every level",
                    axis: "base",
                },
                prelude: [
                    "namespace Outer",
                    "{",
                    "struct Entry { uint8 tag; };",
                    "namespace Middle",
                    "{",
                    "struct Entry { uint32 tag; };",
                    "namespace Inner",
                    "{",
                    "struct Entry { uint64 tag; uint64 extra; };",
                    "}",
                    "}",
                    "}",
                ].join("\n"),
                state: "Outer::Middle::Inner::Entry deep;\nOuter::Entry shallow;\nuint64 deepSize;\nuint64 shallowSize;",
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().deep.tag = input.value;
                            state.mut().deep.extra = input.value + 1;
                            state.mut().shallow.tag = (uint8)input.value;
                            state.mut().deepSize = sizeof(Outer::Middle::Inner::Entry);
                            state.mut().shallowSize = sizeof(Outer::Entry);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 deepSize;\nuint64 shallowSize;\nuint64 tag;",
                        body: `
                            output.deepSize = state.get().deepSize;
                            output.shallowSize = state.get().shallowSize;
                            output.tag = state.get().deep.tag;
                        `,
                    },
                ],
                initialize: "state.mut().deepSize = 0;\nstate.mut().shallowSize = 0;",
            });
            return { source, script: script(PROBE_STEPS) };
        },
    },

    {
        name: "NsSizeofLocalControl",
        family: "namespaces",
        solidity: "negative control (no Solidity origin)",
        stresses: "sizeof over a plain local, a plain global and a namespaced type in one contract — the control row that caught an 8-to-4 regression when the qualified path was fixed",
        caveat: "Deliberately boring. A table with no row that fails when a fix over-reaches is incomplete.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsSizeofLocalControl",
                header: {
                    archetype: "NsSizeofLocalControl",
                    family: "namespaces",
                    solidity: "negative control",
                    stresses: "unqualified sizeof must not move when the qualified path changes",
                    axis: "base",
                },
                prelude: "namespace Port\n{\nstruct Wide { uint64 a; uint64 b; uint64 c; };\n}\n\nstruct GlobalWide { uint64 a; uint64 b; uint64 c; };",
                state: "uint64 localSize;\nuint64 globalSize;\nuint64 namespacedSize;\nuint64 scalarSize;",
                entries: [
                    {
                        name: "Measure",
                        kind: "procedure",
                        number: 1,
                        locals: "GlobalWide sample;\nuint64 counter;",
                        body: `
                            locals.counter = 0;
                            state.mut().localSize = sizeof(locals.sample);
                            state.mut().globalSize = sizeof(GlobalWide);
                            state.mut().namespacedSize = sizeof(Port::Wide);
                            state.mut().scalarSize = sizeof(locals.counter);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 localSize;\nuint64 globalSize;\nuint64 namespacedSize;\nuint64 scalarSize;",
                        body: `
                            output.localSize = state.get().localSize;
                            output.globalSize = state.get().globalSize;
                            output.namespacedSize = state.get().namespacedSize;
                            output.scalarSize = state.get().scalarSize;
                        `,
                    },
                ],
                initialize: "state.mut().localSize = 0;\nstate.mut().globalSize = 0;\nstate.mut().namespacedSize = 0;\nstate.mut().scalarSize = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
