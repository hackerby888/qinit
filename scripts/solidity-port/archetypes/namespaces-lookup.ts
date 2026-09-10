// Lane 4 — which declaration wins, not whether one resolves.
//
// The repo's own suite already asks whether a name resolves: `name-shadowing.test.ts` and
// `namespace-resolution.test.ts` have 11 tests each, and every one of the 22 is of the form
// "custom namespace helper resolves via using namespace" or "a loop counter named `i` counts rather
// than reading as `i`". Not one puts **two same-named declarations with different values** in scope
// and checks *which one* the compiler picks. That is exactly F213's shape, and it is why 143 test
// files under packages/compiler/tests did not catch a constant name being effectively global.
//
// So every archetype here declares colliding names whose *values* differ and reads each through the
// spelling a developer would actually use. A wrong pick is then a wrong number in the state digest.
// Round 5's `namespaces-values.ts` established the method on constants and enums; this file takes it
// into the lookup rules that file did not reach — using-declarations and directives, scoped enums,
// block-scope shadow chains, base members against file scope, and twin inner namespaces.
//
// Ported from Solidity's `scoping`, `constants`, `inheritance` and `enums` semantic tests, where the
// same collisions arise between a contract, its bases, and the libraries it uses.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

interface LookupProbe {
    prelude: string;
    members: string[];
    body: string;
    locals?: string;
    extraStructs?: string;
    expect?: { values: bigint[]; note: string };
}

/**
 * A `Snap` procedure that reads every colliding name and stores what it got, plus a `Read` function
 * that hands the set back. Every member is a `uint64`, so layout cannot mask a mis-resolution: the
 * only way two backends can produce different state is by picking different declarations.
 */
function lookupProbe(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, probe: (axis: AxisAssignment) => LookupProbe): Archetype {
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
                    axis: "lookup probe",
                },
                prelude: spec.prelude,
                extraStructs: spec.extraStructs,
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

export const NAMESPACE_LOOKUP_ARCHETYPES: Archetype[] = [
    lookupProbe(
        {
            name: "NsUsingDeclarationPicksOneOfTwo",
            family: "namespaces",
            solidity: `${SOL}/scoping/scoping_activation.sol`,
            stresses:
                "a using-declaration names one of two colliding constants; the unqualified read must take that one and both qualified reads must still work",
            caveat: "Solidity has no using-declarations for constants; the analogous collision is `using L for uint` plus a same-named library constant.",
        },
        () => ({
            prelude: [
                "namespace Alpha",
                "{",
                "static constexpr uint64 weight = 3;",
                "}",
                "",
                "namespace Beta",
                "{",
                "static constexpr uint64 weight = 90;",
                "}",
                "",
                "using Alpha::weight;",
            ].join("\n"),
            members: ["unqualified", "viaAlpha", "viaBeta", "sum"],
            body: `
                state.mut().unqualified = weight;
                state.mut().viaAlpha = Alpha::weight;
                state.mut().viaBeta = Beta::weight;
                state.mut().sum = Alpha::weight + Beta::weight;
            `,
            expect: {
                values: [3n, 3n, 90n, 93n],
                note: "the using-declaration names Alpha::weight, so the unqualified read is 3; both qualified reads keep their own values",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsUsingDirectiveThenBothQualified",
            family: "namespaces",
            solidity: `${SOL}/scoping/scoping_activation.sol`,
            stresses:
                "a using-directive brings one namespace in wholesale while a second namespace declares the same name; every read here is qualified, so the directive must not change any of them",
        },
        () => ({
            prelude: [
                "namespace Wide",
                "{",
                "static constexpr uint64 limit = 12;",
                "}",
                "",
                "namespace Narrow",
                "{",
                "static constexpr uint64 limit = 400;",
                "}",
                "",
                "using namespace Wide;",
            ].join("\n"),
            members: ["viaWide", "viaNarrow", "product", "difference"],
            body: `
                state.mut().viaWide = Wide::limit;
                state.mut().viaNarrow = Narrow::limit;
                state.mut().product = Wide::limit * Narrow::limit;
                state.mut().difference = Narrow::limit - Wide::limit;
            `,
            expect: {
                values: [12n, 400n, 4800n, 388n],
                note: "every read is qualified, so `using namespace Wide` is irrelevant: 12, 400, 12*400 = 4800, 400-12 = 388",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsTwinInnerNamespaceUnderTwoOuters",
            family: "namespaces",
            solidity: `${SOL}/scoping/scoping.sol`,
            stresses: "the same inner namespace name nested under two different outer namespaces, each declaring the same constant name with a different value",
        },
        () => ({
            prelude: [
                "namespace OuterOne",
                "{",
                "namespace Shared",
                "{",
                "static constexpr uint64 depth = 7;",
                "}",
                "}",
                "",
                "namespace OuterTwo",
                "{",
                "namespace Shared",
                "{",
                "static constexpr uint64 depth = 5000;",
                "}",
                "}",
            ].join("\n"),
            members: ["fromOne", "fromTwo", "sum", "product"],
            body: `
                state.mut().fromOne = OuterOne::Shared::depth;
                state.mut().fromTwo = OuterTwo::Shared::depth;
                state.mut().sum = OuterOne::Shared::depth + OuterTwo::Shared::depth;
                state.mut().product = OuterOne::Shared::depth * OuterTwo::Shared::depth;
            `,
            expect: {
                values: [7n, 5000n, 5007n, 35000n],
                note: "fully qualified through two different outers: 7, 5000, 5007, 35000",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsBlockScopeShadowChain",
            family: "namespaces",
            solidity: `${SOL}/scoping/c99_scoping_activation.sol`,
            stresses: "a name redeclared at three nested block depths with different values, read at each depth and again after the blocks close",
            caveat: "Solidity's c99_scoping test reads the outer `x` in `uint x = x;`. The TypeScript backend used to refuse the whole shape because locals shared one slot per name; block-scope resolution renames the inner binding, and both backends now answer 1, 20, 300, 1 — confirmed on core's WAMR host.",
        },
        () => ({
            prelude: "static constexpr uint64 tier = 1;",
            locals: "uint64 scratch;\nuint64 atOne;\nuint64 atTwo;\nuint64 atThree;\nuint64 afterBlocks;",
            members: ["outer", "depthOne", "depthTwo", "afterAll"],
            body: `
                locals.atOne = tier;
                {
                    uint64 tier = 20;
                    locals.atTwo = tier;
                    {
                        uint64 tier = 300;
                        locals.atThree = tier;
                    }
                }
                locals.afterBlocks = tier;
                state.mut().outer = locals.atOne;
                state.mut().depthOne = locals.atTwo;
                state.mut().depthTwo = locals.atThree;
                state.mut().afterAll = locals.afterBlocks;
            `,
        }),
    ),

    lookupProbe(
        {
            name: "NsBaseMemberVersusFileConstant",
            family: "namespaces",
            solidity: `${SOL}/inheritance/inherited_state_var_shadowing.sol`,
            stresses:
                "a base-class member and a file-scope constant sharing a name: the member read through the object must not pick up the constant, and the bare name must not pick up the member",
        },
        () => ({
            prelude: ["static constexpr uint64 ceiling = 11;", "", "struct Holder", "{", "uint64 ceiling;", "};"].join("\n"),
            locals: "uint64 scratch;\nHolder holder;",
            members: ["fromConstant", "fromMember", "sum", "witness"],
            body: `
                locals.holder.ceiling = 640;
                state.mut().fromConstant = ceiling;
                state.mut().fromMember = locals.holder.ceiling;
                state.mut().sum = ceiling + locals.holder.ceiling;
                state.mut().witness = 1;
            `,
            expect: {
                values: [11n, 640n, 651n, 1n],
                note: "the bare name is the file constant (11), the member read is the field (640), and their sum is 651",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsConstantNameEqualsStructName",
            family: "namespaces",
            solidity: `${SOL}/types/struct_name_collision.sol`,
            stresses: "a namespace declaring both a struct and a constant of the same name, so the constant read and the type spelling collide",
        },
        () => ({
            prelude: [
                "namespace Mixed",
                "{",
                "struct Marker",
                "{",
                "uint64 field;",
                "};",
                "}",
                "",
                "namespace Other",
                "{",
                "static constexpr uint64 Marker = 88;",
                "}",
            ].join("\n"),
            locals: "uint64 scratch;\nMixed::Marker marker;",
            members: ["constantValue", "structField", "sum", "witness"],
            body: `
                locals.marker.field = 4;
                state.mut().constantValue = Other::Marker;
                state.mut().structField = locals.marker.field;
                state.mut().sum = Other::Marker + locals.marker.field;
                state.mut().witness = 1;
            `,
            expect: {
                values: [88n, 4n, 92n, 1n],
                note: "the constant and the struct live in different namespaces, so both spellings keep their own meaning: 88, 4, 92",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsFourNamespacesFirstDeclaredRead",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses:
                "four namespaces declaring the same constant name in increasing order, with the FIRST read last, so a last-declaration-wins bug cannot be masked by read order",
            caveat: "This is the F213 ladder with the reads deliberately reordered: if resolution were merely order-sensitive in the reader rather than the declarer, this would come out differently.",
        },
        () => ({
            prelude: [
                "namespace K1",
                "{",
                "static constexpr uint64 tag = 1;",
                "}",
                "namespace K2",
                "{",
                "static constexpr uint64 tag = 2;",
                "}",
                "namespace K3",
                "{",
                "static constexpr uint64 tag = 4;",
                "}",
                "namespace K4",
                "{",
                "static constexpr uint64 tag = 8;",
                "}",
            ].join("\n"),
            members: ["fourth", "third", "second", "first"],
            body: `
                state.mut().fourth = K4::tag;
                state.mut().third = K3::tag;
                state.mut().second = K2::tag;
                state.mut().first = K1::tag;
            `,
            expect: {
                values: [8n, 4n, 2n, 1n],
                note: "each qualified name is its own declaration regardless of the order they are read in",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsEnumConstantVersusNamespaceConstant",
            family: "namespaces",
            solidity: `${SOL}/enums/enum_explicit_overflow.sol`,
            stresses: "an enum constant in one namespace and a plain constant of the same name in another, read through both qualified spellings and combined",
        },
        () => ({
            prelude: [
                "namespace AsEnum",
                "{",
                "enum Levels",
                "{",
                "grade = 6",
                "};",
                "}",
                "",
                "namespace AsConstant",
                "{",
                "static constexpr uint64 grade = 900;",
                "}",
            ].join("\n"),
            members: ["fromEnum", "fromConstant", "sum", "product"],
            body: `
                state.mut().fromEnum = AsEnum::grade;
                state.mut().fromConstant = AsConstant::grade;
                state.mut().sum = AsEnum::grade + AsConstant::grade;
                state.mut().product = AsEnum::grade * AsConstant::grade;
            `,
            expect: {
                values: [6n, 900n, 906n, 5400n],
                note: "an enum constant and a namespace constant are different entities: 6, 900, 906, 5400",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsSameNameThreeKindsOneExpression",
            family: "namespaces",
            solidity: `${SOL}/scoping/scoping_activation.sol`,
            stresses:
                "a file constant, an enum constant and a local all named the same, combined in one expression so a wrong pick changes the arithmetic rather than only one member",
        },
        () => ({
            prelude: [
                "namespace AsConst",
                "{",
                "static constexpr uint64 span = 2;",
                "}",
                "",
                "namespace AsEnum",
                "{",
                "enum Widths",
                "{",
                "span = 30",
                "};",
                "}",
            ].join("\n"),
            locals: "uint64 scratch;\nuint64 span;",
            members: ["localValue", "constValue", "enumValue", "combined"],
            body: `
                locals.span = 500;
                state.mut().localValue = locals.span;
                state.mut().constValue = AsConst::span;
                state.mut().enumValue = AsEnum::span;
                state.mut().combined = locals.span + AsConst::span + AsEnum::span;
            `,
            expect: {
                values: [500n, 2n, 30n, 532n],
                note: "the local is reached through `locals.`, and the two qualified names keep their own values: 500 + 2 + 30 = 532",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsTwoEnumsOneNamespaceSharedConstantName",
            family: "namespaces",
            solidity: `${SOL}/enums/enum_referencing.sol`,
            stresses:
                "two different enum types declared in the SAME namespace, sharing one constant name — so namespace qualification cannot disambiguate them and only the enum type can",
            caveat: "C++ plain enums export their constants into the enclosing scope, so this pair is ill-formed if both spell the same constant; the shared name is given different values per type to make a wrong pick visible.",
        },
        () => ({
            prelude: ["namespace Single", "{", "enum First", "{", "alpha = 3,", "shared = 15", "};", "", "enum Second", "{", "beta = 9", "};", "}"].join("\n"),
            members: ["alphaValue", "sharedValue", "betaValue", "sum"],
            body: `
                state.mut().alphaValue = Single::alpha;
                state.mut().sharedValue = Single::shared;
                state.mut().betaValue = Single::beta;
                state.mut().sum = Single::alpha + Single::shared + Single::beta;
            `,
            expect: {
                values: [3n, 15n, 9n, 27n],
                note: "two enum types in one namespace with distinct constant names: 3, 15, 9, sum 27",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsConstantShadowedByEntryInputField",
            family: "namespaces",
            solidity: `${SOL}/scoping/scoping_activation.sol`,
            stresses: "an entry input field named exactly like a file-scope constant, so `input.seed` and the bare constant must stay distinct",
        },
        () => ({
            prelude: "static constexpr uint64 seed = 77;",
            members: ["fromConstant", "fromInput", "sum", "witness"],
            body: `
                state.mut().fromConstant = seed;
                state.mut().fromInput = input.seed;
                state.mut().sum = seed + input.seed;
                state.mut().witness = 1;
            `,
            expect: {
                values: [77n, 1n, 78n, 1n],
                note: "on the first call input.seed is 1, so the bare constant is 77 and the sum is 78",
            },
        }),
    ),

    lookupProbe(
        {
            name: "NsAliasAndTargetBothNameConstants",
            family: "namespaces",
            solidity: `${SOL}/constants/constant_variables.sol`,
            stresses: "a namespace alias pointing at one of two same-named namespaces, with the constant read through the alias, the target and the twin",
            caveat: "Round 5 pinned the two-level form `namespace Short = Long::Inner;` as a declared limitation. This row shows the limitation is broader than that: even the one-level `namespace Alias = Target;` is refused, with the same explicit `unsupported construct at '=' — build this contract with clang` diagnostic. A declared limitation rather than a defect, pinned so the row notices if support ever lands.",
            expectedVerdict: "one-side-rejected",
        },
        () => ({
            prelude: [
                "namespace Target",
                "{",
                "static constexpr uint64 mark = 25;",
                "}",
                "",
                "namespace Twin",
                "{",
                "static constexpr uint64 mark = 640;",
                "}",
                "",
                "namespace Alias = Target;",
            ].join("\n"),
            members: ["viaAlias", "viaTarget", "viaTwin", "sum"],
            body: `
                state.mut().viaAlias = Alias::mark;
                state.mut().viaTarget = Target::mark;
                state.mut().viaTwin = Twin::mark;
                state.mut().sum = Alias::mark + Twin::mark;
            `,
        }),
    ),
];
