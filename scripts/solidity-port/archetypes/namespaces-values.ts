// Name resolution, checked by value.
//
// Round 4 found F213 — a qualified enum constant resolving to the last-declared constant of that name —
// and it found it because one archetype compared *numbers* rather than layouts. Three earlier rounds of
// namespace archetypes had compared struct sizes and offsets, which a mis-resolution between two
// identically shaped types cannot disturb. This file is the follow-up: every archetype declares two or
// more same-named things whose values differ, reads each through its qualified name, and stores the
// results. A wrong pick is then a wrong number in the digest, not a coincidence of layout.
//
// Ported from Solidity's `scoping`, `constants`, `libraries`, `enums` and `inheritance` tests, where the
// same collisions arise between libraries and contracts.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

interface ValueProbe {
    /** Declarations placed above the contract. */
    prelude: string;
    /** `uint64` state members the probe writes, in order. */
    members: string[];
    /** Body of the `Snap` procedure; `input.seed` is available. */
    body: string;
    /** Extra locals for `Snap`. */
    locals?: string;
    /** Expected values of `members` after the first Snap, when they follow from the C++ rule alone. */
    expect?: { values: bigint[]; note: string };
}

/**
 * The shape shared by this file: a `Snap` procedure that reads every colliding name and stores what it
 * got, and a `Read` function that hands the whole set back. Nothing here is about layout — every member
 * is a uint64 — so the only way two backends can differ is by resolving a name differently.
 */
function valueProbe(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, probe: (axis: AxisAssignment) => ValueProbe): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["placement", "temporaries"],
        build(axis) {
            const spec = probe(axis);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: "value probe",
                },
                prelude: spec.prelude,
                state: `${spec.members.map((member) => `uint64 ${member};`).join("\n")}\nuint64 calls;`,
                entries: [
                    {
                        name: "Snap",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: spec.locals ?? "uint64 scratch;",
                        body: `${spec.body}\nstate.mut().calls++;`,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${spec.members.map((member) => `uint64 ${member};`).join("\n")}\nuint64 calls;`,
                        body: [...spec.members.map((member) => `output.${member} = state.get().${member};`), "output.calls = state.get().calls;"].join("\n"),
                    },
                ],
                initialize: [...spec.members.map((member) => `state.mut().${member} = 0;`), "state.mut().calls = 0;"].join("\n"),
            });
            const steps: CallStep[] = [
                { kind: "procedure", entry: 1, in: u64(1), invocator: 0, note: "seed 1" },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0, note: "seed 0" },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(18446744073709551615n), invocator: 0, note: "seed max" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ];
            const built = script(steps);
            if (spec.expect) {
                built.expect = [
                    {
                        step: 1,
                        out: [...spec.expect.values, 1n].map((value) => u64(value)).join(""),
                        source: "cpp-rule",
                        note: spec.expect.note,
                    },
                ];
            }
            return { source, script: built };
        },
    };
}

export const NAMESPACE_VALUE_ARCHETYPES: Archetype[] = [
    valueProbe(
        {
            name: "NsTwinConstantsQualifiedRead",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses: "two namespaced constants of the same name and different values, both read through their qualified names in one statement",
            caveat: "Solidity has no namespaces; the same collision arises between two libraries, and the qualified read is `L.C`.",
        },
        () => ({
            prelude: "namespace Alpha\n{\nstatic constexpr uint64 rate = 3;\n}\n\nnamespace Beta\n{\nstatic constexpr uint64 rate = 700;\n}",
            members: ["alphaRate", "betaRate", "product", "sum"],
            body: `
                state.mut().alphaRate = Alpha::rate;
                state.mut().betaRate = Beta::rate;
                state.mut().product = Alpha::rate * Beta::rate;
                state.mut().sum = Alpha::rate + Beta::rate;
            `,
            expect: { values: [3n, 700n, 2100n, 703n], note: "Alpha::rate = 3 and Beta::rate = 700 by declaration" },
        }),
    ),

    valueProbe(
        {
            name: "NsTwinConstantsThreeDeep",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses: "the same constant name in three namespaces plus one at file scope, read through all four spellings",
        },
        () => ({
            prelude:
                "static constexpr uint64 limit = 1;\n\nnamespace One\n{\nstatic constexpr uint64 limit = 10;\n}\n\nnamespace Two\n{\nstatic constexpr uint64 limit = 100;\n}\n\nnamespace Three\n{\nstatic constexpr uint64 limit = 1000;\n}",
            members: ["one", "two", "three", "fileScope", "combined"],
            body: `
                state.mut().one = One::limit;
                state.mut().two = Two::limit;
                state.mut().three = Three::limit;
                state.mut().fileScope = limit;
                state.mut().combined = One::limit + Two::limit + Three::limit + limit;
            `,
            expect: { values: [10n, 100n, 1000n, 1n, 1111n], note: "each namespace's own limit, plus the file-scope one" },
        }),
    ),

    valueProbe(
        {
            name: "NsTwinEnumsAcrossFourNamespaces",
            family: "namespaces",
            solidity: `${SOL}/enums/using_enums.sol`,
            stresses:
                "four enums sharing one constant name across four namespaces, so the last-declared-wins rule F213 describes is visible at every position rather than only the last",
            caveat: "This is the F213 shape widened: the earlier archetype used two namespaces, this one uses four so a resolution that picks the first, the last or any middle declaration is distinguishable.",
        },
        () => ({
            prelude:
                "namespace K1\n{\nenum Kind { Tag = 1 };\n}\n\nnamespace K2\n{\nenum Kind { Tag = 2 };\n}\n\nnamespace K3\n{\nenum Kind { Tag = 4 };\n}\n\nnamespace K4\n{\nenum Kind { Tag = 8 };\n}",
            members: ["first", "second", "third", "fourth", "mask"],
            body: `
                state.mut().first = (uint64)K1::Tag;
                state.mut().second = (uint64)K2::Tag;
                state.mut().third = (uint64)K3::Tag;
                state.mut().fourth = (uint64)K4::Tag;
                state.mut().mask = (uint64)K1::Tag | (uint64)K2::Tag | (uint64)K3::Tag | (uint64)K4::Tag;
            `,
            expect: { values: [1n, 2n, 4n, 8n, 15n], note: "one bit per namespace; the OR of all four is 15" },
        }),
    ),

    valueProbe(
        {
            name: "NsEnumConstantVersusFileConstant",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses: "an enum constant in a namespace and a file-scope constant of the same name, both read qualified and unqualified",
        },
        () => ({
            prelude: "static constexpr uint64 Threshold = 5;\n\nnamespace Port\n{\nenum Limits { Threshold = 55 };\n}",
            members: ["fromEnum", "fromFile", "difference"],
            body: `
                state.mut().fromEnum = (uint64)Port::Threshold;
                state.mut().fromFile = Threshold;
                state.mut().difference = (uint64)Port::Threshold - Threshold;
            `,
            expect: { values: [55n, 5n, 50n], note: "Port::Threshold = 55, the file-scope Threshold = 5" },
        }),
    ),

    valueProbe(
        {
            name: "NsTypedefsToDifferentWidths",
            family: "namespaces",
            solidity: `${SOL}/libraries/using_library_structs.sol`,
            stresses:
                "the same typedef name in two namespaces aliasing different scalar widths, used for a cast — a mis-resolution truncates or widens the value instead of failing",
        },
        () => ({
            prelude: "namespace Narrow\n{\nusing Amount = uint16;\n}\n\nnamespace Wide\n{\nusing Amount = uint64;\n}",
            members: ["narrowCast", "wideCast", "narrowSize", "wideSize"],
            body: `
                state.mut().narrowCast = (uint64)(Narrow::Amount)(input.seed + 100000);
                state.mut().wideCast = (uint64)(Wide::Amount)(input.seed + 100000);
                state.mut().narrowSize = sizeof(Narrow::Amount);
                state.mut().wideSize = sizeof(Wide::Amount);
            `,
            expect: { values: [34465n, 100001n, 2n, 8n], note: "100001 truncated to uint16 is 34465; the wide cast keeps it" },
        }),
    ),

    valueProbe(
        {
            name: "NsSameNamedStructsDifferentFieldValues",
            family: "namespaces",
            solidity: `${SOL}/libraries/library_struct_size.sol`,
            stresses:
                "two same-named structs whose fields have the same names and the same widths but are written with different values through each spelling — identical layouts, so only the values can tell the resolution apart",
            caveat: "This is deliberately the case round 1's twin-struct archetypes could not catch: the sizes match, so a size comparison sees nothing.",
        },
        () => ({
            prelude:
                "namespace Alpha\n{\nstruct Record\n{\n    uint64 a;\n    uint64 b;\n};\n}\n\nnamespace Beta\n{\nstruct Record\n{\n    uint64 a;\n    uint64 b;\n};\n}",
            locals: "Alpha::Record alpha;\nBeta::Record beta;",
            members: ["alphaA", "alphaB", "betaA", "betaB", "sizesEqual"],
            body: `
                locals.alpha.a = 11;
                locals.alpha.b = 22;
                locals.beta.a = 33;
                locals.beta.b = 44;
                state.mut().alphaA = locals.alpha.a;
                state.mut().alphaB = locals.alpha.b;
                state.mut().betaA = locals.beta.a;
                state.mut().betaB = locals.beta.b;
                state.mut().sizesEqual = sizeof(Alpha::Record) == sizeof(Beta::Record) ? 1 : 0;
            `,
            expect: { values: [11n, 22n, 33n, 44n, 1n], note: "two distinct objects of identically shaped types" },
        }),
    ),

    valueProbe(
        {
            name: "NsNestedNamespaceConstants",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses:
                "constants of one name at three nesting depths — Outer, Outer::Middle and Outer::Middle::Deep — where the qualification length is the only thing distinguishing them",
        },
        () => ({
            prelude:
                "namespace Outer\n{\nstatic constexpr uint64 value = 2;\nnamespace Middle\n{\nstatic constexpr uint64 value = 20;\nnamespace Deep\n{\nstatic constexpr uint64 value = 200;\n}\n}\n}",
            members: ["outer", "middle", "deep", "weighted"],
            body: `
                state.mut().outer = Outer::value;
                state.mut().middle = Outer::Middle::value;
                state.mut().deep = Outer::Middle::Deep::value;
                state.mut().weighted = Outer::value * 100 + Outer::Middle::value * 10 + Outer::Middle::Deep::value;
            `,
            expect: { values: [2n, 20n, 200n, 600n], note: "2*100 + 20*10 + 200 = 600" },
        }),
    ),

    valueProbe(
        {
            name: "NsConstantShadowedByLocal",
            family: "namespaces",
            solidity: `${SOL}/scoping/name_shadowing.sol`,
            stresses:
                "a `_locals` member with the same name as a namespaced constant, with both read in the same body — the local wins unqualified, the constant is still reachable qualified",
        },
        () => ({
            prelude: "namespace Port\n{\nstatic constexpr uint64 factor = 9;\n}",
            locals: "uint64 factor;",
            members: ["fromLocal", "fromNamespace", "product"],
            body: `
                locals.factor = 4;
                state.mut().fromLocal = locals.factor;
                state.mut().fromNamespace = Port::factor;
                state.mut().product = locals.factor * Port::factor;
            `,
            expect: { values: [4n, 9n, 36n], note: "the local is 4, the constant is 9" },
        }),
    ),

    valueProbe(
        {
            name: "NsUsingNamespaceThenQualified",
            family: "namespaces",
            solidity: `${SOL}/using/using_for_function_on_int.sol`,
            stresses:
                "`using namespace` bringing one constant into scope while a second namespace declares the same name — the unqualified read must take the used one, and both qualified reads must still work",
        },
        () => ({
            prelude:
                "namespace Used\n{\nstatic constexpr uint64 weight = 6;\n}\n\nnamespace Unused\n{\nstatic constexpr uint64 weight = 60;\n}\n\nusing namespace Used;",
            members: ["unqualified", "usedQualified", "unusedQualified", "total"],
            body: `
                state.mut().unqualified = weight;
                state.mut().usedQualified = Used::weight;
                state.mut().unusedQualified = Unused::weight;
                state.mut().total = weight + Used::weight + Unused::weight;
            `,
            expect: { values: [6n, 6n, 60n, 72n], note: "the used namespace supplies the unqualified spelling" },
        }),
    ),

    valueProbe(
        {
            name: "NsEnumUnderlyingArithmetic",
            family: "namespaces",
            solidity: `${SOL}/enums/enum_explicit_overflow.sol`,
            stresses:
                "enum constants at the edges of their underlying type — 0, 255, 256, 65535 and 65536 — cast to uint64 and combined, so a wrong underlying width truncates a value rather than failing to compile",
        },
        () => ({
            prelude: "namespace Range\n{\nenum Wide { Zero = 0, Byte = 255, PastByte = 256, Word = 65535, PastWord = 65536 };\n}",
            members: ["zero", "byteEdge", "pastByte", "wordEdge", "pastWord"],
            body: `
                state.mut().zero = (uint64)Range::Zero;
                state.mut().byteEdge = (uint64)Range::Byte;
                state.mut().pastByte = (uint64)Range::PastByte;
                state.mut().wordEdge = (uint64)Range::Word;
                state.mut().pastWord = (uint64)Range::PastWord;
            `,
            expect: { values: [0n, 255n, 256n, 65535n, 65536n], note: "every constant survives the widening cast intact" },
        }),
    ),

    valueProbe(
        {
            name: "NsConstantInArrayIndex",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses:
                "two same-named constants used as array indices — a mis-resolution reads a different element rather than producing a different scalar, which is the shape a value probe would otherwise miss",
        },
        () => ({
            prelude: "namespace Low\n{\nstatic constexpr uint64 slot = 1;\n}\n\nnamespace High\n{\nstatic constexpr uint64 slot = 6;\n}",
            locals: "Array<uint64, 8> table;\nuint64 i;",
            members: ["atLow", "atHigh", "sum"],
            body: `
                for (locals.i = 0; locals.i < 8; locals.i++)
                {
                    locals.table.set(locals.i, locals.i * 100);
                }
                state.mut().atLow = locals.table.get(Low::slot);
                state.mut().atHigh = locals.table.get(High::slot);
                state.mut().sum = locals.table.get(Low::slot) + locals.table.get(High::slot);
            `,
            expect: { values: [100n, 600n, 700n], note: "element 1 is 100 and element 6 is 600" },
        }),
    ),

    valueProbe(
        {
            name: "NsConstantAsShiftCount",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses:
                "same-named constants used as shift counts, where picking the wrong one moves the bit by a different distance — combined with F204's territory, since one of the counts is at the operand width",
        },
        () => ({
            prelude: "namespace Small\n{\nstatic constexpr uint64 shift = 3;\n}\n\nnamespace Big\n{\nstatic constexpr uint64 shift = 40;\n}",
            members: ["small", "big", "combined"],
            body: `
                state.mut().small = 1ULL << Small::shift;
                state.mut().big = 1ULL << Big::shift;
                state.mut().combined = (1ULL << Small::shift) | (1ULL << Big::shift);
            `,
            expect: { values: [8n, 1099511627776n, 1099511627784n], note: "2^3 and 2^40, and their OR" },
        }),
    ),

    valueProbe(
        {
            name: "NsMemberNameEqualsNamespaceName",
            family: "namespaces",
            solidity: `${SOL}/scoping/name_shadowing.sol`,
            stresses: "a state member named exactly like a namespace, with that namespace's constant read in the same statement that writes the member",
        },
        () => ({
            prelude: "namespace Port\n{\nstatic constexpr uint64 base = 12;\n}",
            members: ["Port", "fromNamespace", "sum"],
            body: `
                state.mut().Port = input.seed + 1;
                state.mut().fromNamespace = Port::base;
                state.mut().sum = state.get().Port + Port::base;
            `,
            expect: { values: [2n, 12n, 14n], note: "seed 1 makes the member 2; the namespace constant is 12" },
        }),
    ),

    valueProbe(
        {
            name: "NsConstantExpressionsFolded",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_expressions.sol`,
            stresses:
                "constants defined in terms of other constants across namespaces, so the folded value depends on resolving a chain rather than a single name",
        },
        () => ({
            prelude:
                "namespace Base\n{\nstatic constexpr uint64 unit = 7;\n}\n\nnamespace Derived\n{\nstatic constexpr uint64 unit = Base::unit * 3;\nstatic constexpr uint64 doubled = unit * 2;\n}",
            members: ["baseUnit", "derivedUnit", "derivedDoubled", "check"],
            body: `
                state.mut().baseUnit = Base::unit;
                state.mut().derivedUnit = Derived::unit;
                state.mut().derivedDoubled = Derived::doubled;
                state.mut().check = Derived::doubled == Base::unit * 6 ? 1 : 0;
            `,
            expect: { values: [7n, 21n, 42n, 1n], note: "7, 7*3, 7*6, and the identity holds" },
        }),
    ),

    valueProbe(
        {
            name: "NsSameNameAcrossEnumAndStruct",
            family: "namespaces",
            solidity: `${SOL}/scoping/name_shadowing.sol`,
            stresses:
                "one name declared as an enum constant in one namespace and as a struct in another, so the two live in different declaration kinds and only the use site says which was meant",
        },
        () => ({
            prelude: "namespace AsEnum\n{\nenum Tags { Marker = 77 };\n}\n\nnamespace AsStruct\n{\nstruct Marker\n{\n    uint64 a;\n    uint64 b;\n};\n}",
            locals: "AsStruct::Marker marker;",
            members: ["enumValue", "structSize", "structField"],
            body: `
                state.mut().enumValue = (uint64)AsEnum::Marker;
                locals.marker.a = 5;
                locals.marker.b = 6;
                state.mut().structSize = sizeof(AsStruct::Marker);
                state.mut().structField = locals.marker.a + locals.marker.b;
            `,
            expect: { values: [77n, 16n, 11n], note: "the enum constant is 77; the struct is two uint64s" },
        }),
    ),

    valueProbe(
        {
            name: "NsConstantsInTernaryArms",
            family: "namespaces",
            solidity: `${SOL}/expressions/conditional_expression_type.sol`,
            stresses: "same-named constants from two namespaces as the two arms of a conditional, driven so that both arms are taken across the script",
        },
        () => ({
            prelude: "namespace Yes\n{\nstatic constexpr uint64 answer = 111;\n}\n\nnamespace No\n{\nstatic constexpr uint64 answer = 222;\n}",
            members: ["chosen", "opposite", "both"],
            body: `
                state.mut().chosen = input.seed > 0 ? Yes::answer : No::answer;
                state.mut().opposite = input.seed > 0 ? No::answer : Yes::answer;
                state.mut().both = Yes::answer + No::answer;
            `,
            expect: { values: [111n, 222n, 333n], note: "seed 1 takes the Yes arm" },
        }),
    ),

    valueProbe(
        {
            name: "NsConstantThroughNestedPath",
            family: "namespaces",
            solidity: `${SOL}/libraries/using_library_structs.sol`,
            stresses: "a constant declared two namespaces deep, read through its full path from the entry body and again inside an expression",
            caveat: "This row read the same constant through a `namespace Short = Long::Inner;` alias until that was dropped: the TypeScript front end declines a namespace alias by design, naming clang as the way to build it, and no QPI contract would contain one. The nested-path read it was really about is unchanged.",
        },
        () => ({
            prelude: "namespace Long\n{\nnamespace Inner\n{\nstatic constexpr uint64 depth = 33;\n}\n}",
            members: ["viaFullPath", "viaExpression", "equal"],
            body: `
                state.mut().viaFullPath = Long::Inner::depth;
                state.mut().viaExpression = Long::Inner::depth * 2 - Long::Inner::depth;
                state.mut().equal = Long::Inner::depth == state.get().viaFullPath ? 1 : 0;
            `,
            expect: { values: [33n, 33n, 1n], note: "the nested path names one constant however it is reached" },
        }),
    ),

    valueProbe(
        {
            name: "NsQualifiedInsideLoopBody",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses: "the qualified constant read inside a loop body, so the resolution happens where a compiler is most likely to hoist or fold it",
        },
        () => ({
            prelude: "namespace Step\n{\nstatic constexpr uint64 size = 5;\n}\n\nnamespace Other\n{\nstatic constexpr uint64 size = 50;\n}",
            locals: "uint64 i;\nuint64 total;",
            members: ["loopTotal", "iterations", "lastStep"],
            body: `
                locals.total = 0;
                for (locals.i = 0; locals.i < 4; locals.i++)
                {
                    locals.total += Step::size * locals.i + Other::size;
                    state.mut().lastStep = Step::size;
                }
                state.mut().loopTotal = locals.total;
                state.mut().iterations = locals.i;
            `,
            expect: { values: [230n, 4n, 5n], note: "5*(0+1+2+3) + 4*50 = 30 + 200" },
        }),
    ),
];
