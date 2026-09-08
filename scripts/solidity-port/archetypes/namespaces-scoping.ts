// More name resolution, aimed where round 3 found F205: the boundary between class scope and file scope.
//
// Ported from Solidity's `scoping`, `constants`, `libraries` and `inheritance` tests. Round 3 found that
// the TypeScript backend resolves an unqualified name to a file-scope enum constant even when a member
// of the contract hides it, which clang refuses. These archetypes walk the rest of that boundary: a
// constant hidden by a state member, an input field named like a type, a locals member named like a
// namespace, a struct inheriting twins, and the qualified spelling of each as its control. Every one
// writes a number into state that is only correct if the intended declaration was picked.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

function drive(values: bigint[]): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry: 1, in: u64(value), invocator: 0, note: `value ${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

const VALUES = [0n, 1n, 9n, 4294967296n, 18446744073709551615n];

export const NAMESPACE_SCOPING_ARCHETYPES: Archetype[] = [
    {
        name: "NsFileConstantHiddenByStateMember",
        family: "namespaces",
        solidity: `${SOL}/constants/constant_variables.sol`,
        stresses:
            "a file-scope constant and a state member of the same name, read unqualified inside a procedure — the member wins in C++, and the qualified spelling next to it says which was meant",
        caveat: "Solidity resolves a state variable over a file-level constant too; the port keeps both spellings in one contract so the pick is visible in the digest.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsFileConstantHiddenByStateMember",
                header: {
                    archetype: "NsFileConstantHiddenByStateMember",
                    family: "namespaces",
                    solidity: `${SOL}/constants/constant_variables.sol`,
                    stresses: "state member hiding a file-scope constant",
                    caveat: "both spellings live in one contract",
                    axis: "constant hidden by member",
                },
                prelude: "namespace Port\n{\nstatic constexpr uint64 threshold = 100;\n}\n\nstatic constexpr uint64 threshold = 7;",
                state: "uint64 unqualified;\nuint64 qualifiedNamespace;\nuint64 sum;",
                entries: [
                    {
                        name: "Compare",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            // Unqualified: the file-scope constant, since no member is called threshold.
                            locals.scratch = input.value > threshold ? 1 : 0;
                            state.mut().unqualified = locals.scratch;
                            state.mut().qualifiedNamespace = input.value > Port::threshold ? 1 : 0;
                            state.mut().sum = state.get().unqualified + state.get().qualifiedNamespace;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 unqualified;\nuint64 qualifiedNamespace;\nuint64 sum;",
                        body: `
                            output.unqualified = state.get().unqualified;
                            output.qualifiedNamespace = state.get().qualifiedNamespace;
                            output.sum = state.get().sum;
                        `,
                    },
                ],
                initialize: "state.mut().unqualified = 0;\nstate.mut().qualifiedNamespace = 0;\nstate.mut().sum = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsInputFieldNamedLikeType",
        family: "namespaces",
        solidity: `${SOL}/scoping/name_shadowing.sol`,
        stresses: "an input field whose name is also a struct type in scope, used in an expression where either reading could compile",
        caveat: "Solidity forbids a variable named like a user type in the same scope; QPI inherits C++'s rule instead, which allows it.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsInputFieldNamedLikeType",
                header: {
                    archetype: "NsInputFieldNamedLikeType",
                    family: "namespaces",
                    solidity: `${SOL}/scoping/name_shadowing.sol`,
                    stresses: "a field named like a type in scope",
                    caveat: "legal in C++, rejected by Solidity",
                    axis: "field named like a type",
                },
                prelude: "struct amount\n{\n    uint64 a;\n    uint64 b;\n};",
                state: "uint64 fromField;\nuint64 fromType;\nuint64 calls;",
                entries: [
                    {
                        name: "Use",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.amount * 2;
                            state.mut().fromField = locals.scratch;
                            // The type of the same name is still reachable, and its size is a constant.
                            state.mut().fromType = sizeof(amount);
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 fromField;\nuint64 fromType;\nuint64 calls;",
                        body: "output.fromField = state.get().fromField;\noutput.fromType = state.get().fromType;\noutput.calls = state.get().calls;",
                    },
                ],
                initialize: "state.mut().fromField = 0;\nstate.mut().fromType = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsTwinEnumSameConstantNames",
        family: "namespaces",
        solidity: `${SOL}/enums/using_enums.sol`,
        stresses:
            "two enums in two namespaces declaring the same constant names with different values — every use has to be qualified, and picking the wrong one changes an arithmetic result rather than failing to compile",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsTwinEnumSameConstantNames",
                header: {
                    archetype: "NsTwinEnumSameConstantNames",
                    family: "namespaces",
                    solidity: `${SOL}/enums/using_enums.sol`,
                    stresses: "same constant names, different values, two namespaces",
                    axis: "twin enums",
                },
                prelude: "namespace Alpha\n{\nenum Level { Low = 1, High = 2 };\n}\n\nnamespace Beta\n{\nenum Level { Low = 100, High = 200 };\n}",
                state: "uint64 alphaSum;\nuint64 betaSum;\nuint64 mixed;\nuint64 calls;",
                entries: [
                    {
                        name: "Score",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 weight;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.weight;
                            state.mut().alphaSum += locals.scratch * (uint64)Alpha::Low + (uint64)Alpha::High;
                            state.mut().betaSum += locals.scratch * (uint64)Beta::Low + (uint64)Beta::High;
                            state.mut().mixed += (uint64)Alpha::High * (uint64)Beta::Low;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 alphaSum;\nuint64 betaSum;\nuint64 mixed;\nuint64 calls;",
                        body: `
                            output.alphaSum = state.get().alphaSum;
                            output.betaSum = state.get().betaSum;
                            output.mixed = state.get().mixed;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().alphaSum = 0;\nstate.mut().betaSum = 0;\nstate.mut().mixed = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsConstantAsContainerCapacity",
        family: "namespaces",
        solidity: `${SOL}/constants/constant_variables.sol`,
        stresses:
            "a namespaced constexpr used as an Array capacity — a name that has to resolve at compile time and produce a power of two, where a wrong pick changes the container's size and therefore every offset after it",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsConstantAsContainerCapacity",
                header: {
                    archetype: "NsConstantAsContainerCapacity",
                    family: "namespaces",
                    solidity: `${SOL}/constants/constant_variables.sol`,
                    stresses: "a namespaced constant in a template argument",
                    axis: "constant as capacity",
                },
                prelude: "namespace Small\n{\nstatic constexpr uint64 capacity = 4;\n}\n\nnamespace Large\n{\nstatic constexpr uint64 capacity = 16;\n}",
                state: "Array<uint64, Small::capacity> small;\nArray<uint64, Large::capacity> large;\nuint64 smallSize;\nuint64 largeSize;\nuint64 writes;",
                entries: [
                    {
                        name: "Fill",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 i;",
                        body: `
                            for (locals.i = 0; locals.i < Small::capacity; locals.i++)
                            {
                                state.mut().small.set(locals.i, input.value + locals.i);
                            }
                            for (locals.i = 0; locals.i < Large::capacity; locals.i++)
                            {
                                state.mut().large.set(locals.i, input.value * 2 + locals.i);
                            }
                            state.mut().smallSize = sizeof(state.get().small);
                            state.mut().largeSize = sizeof(state.get().large);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 smallSize;\nuint64 largeSize;\nuint64 smallLast;\nuint64 largeLast;\nuint64 writes;",
                        body: `
                            output.smallSize = state.get().smallSize;
                            output.largeSize = state.get().largeSize;
                            output.smallLast = state.get().small.get(Small::capacity - 1);
                            output.largeLast = state.get().large.get(Large::capacity - 1);
                            output.writes = state.get().writes;
                        `,
                    },
                ],
                initialize:
                    "state.mut().small.setAll(0);\nstate.mut().large.setAll(0);\nstate.mut().smallSize = 0;\nstate.mut().largeSize = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsStructInheritsTwinBases",
        family: "namespaces",
        solidity: `${SOL}/inheritance/base_base_overload.sol`,
        stresses:
            "a struct inheriting one twin while a member of the other twin sits beside it — same member names, different offsets, and only the qualification says which is which",
        caveat: "Solidity's version is diamond inheritance between contracts; QPI has no contract inheritance, so the port inherits plain structs.",
        axes: ["placement", "ns"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsStructInheritsTwinBases",
                header: {
                    archetype: "NsStructInheritsTwinBases",
                    family: "namespaces",
                    solidity: `${SOL}/inheritance/base_base_overload.sol`,
                    stresses: "inheriting one twin, holding the other",
                    caveat: "struct inheritance stands in for contract inheritance",
                    axis: "twin bases",
                },
                prelude:
                    "namespace Alpha\n{\nstruct Base\n{\n    uint64 first;\n    uint32 second;\n};\n}\n\nnamespace Beta\n{\nstruct Base\n{\n    uint32 first;\n    uint64 second;\n};\n}\n\nstruct Derived : public Alpha::Base\n{\n    uint64 extra;\n};",
                state: "Derived derived;\nBeta::Base other;\nuint64 derivedSize;\nuint64 otherSize;\nuint64 writes;",
                entries: [
                    {
                        name: "Assign",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value;
                            state.mut().derived.first = locals.scratch;
                            state.mut().derived.second = (uint32)locals.scratch;
                            state.mut().derived.extra = locals.scratch * 3;
                            state.mut().other.first = (uint32)locals.scratch;
                            state.mut().other.second = locals.scratch * 5;
                            state.mut().derivedSize = sizeof(Derived);
                            state.mut().otherSize = sizeof(Beta::Base);
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 derivedFirst;\nuint32 derivedSecond;\nuint64 derivedExtra;\nuint32 otherFirst;\nuint64 otherSecond;\nuint64 derivedSize;\nuint64 otherSize;",
                        body: `
                            output.derivedFirst = state.get().derived.first;
                            output.derivedSecond = state.get().derived.second;
                            output.derivedExtra = state.get().derived.extra;
                            output.otherFirst = state.get().other.first;
                            output.otherSecond = state.get().other.second;
                            output.derivedSize = state.get().derivedSize;
                            output.otherSize = state.get().otherSize;
                        `,
                    },
                ],
                initialize: "state.mut().derivedSize = 0;\nstate.mut().otherSize = 0;\nstate.mut().writes = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsQualifiedAndUnqualifiedInOneExpression",
        family: "namespaces",
        solidity: `${SOL}/using/using_for_function_on_int.sol`,
        stresses:
            "the qualified and unqualified spellings of the same constant multiplied together in one expression — one statement, two lookups, and the product only comes out right if both resolve as intended",
        axes: ["placement", "constSource"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsQualifiedAndUnqualifiedInOneExpression",
                header: {
                    archetype: "NsQualifiedAndUnqualifiedInOneExpression",
                    family: "namespaces",
                    solidity: `${SOL}/using/using_for_function_on_int.sol`,
                    stresses: "two spellings of one name in a single expression",
                    axis: "mixed qualification",
                },
                prelude: "namespace Port\n{\nstatic constexpr uint64 factor = 3;\n}\n\nusing namespace Port;\n\nstatic constexpr uint64 offset = 11;",
                state: "uint64 product;\nuint64 viaQualified;\nuint64 viaUnqualified;\nuint64 calls;",
                entries: [
                    {
                        name: "Compute",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value;
                            state.mut().viaQualified = locals.scratch * Port::factor + offset;
                            state.mut().viaUnqualified = locals.scratch * factor + offset;
                            state.mut().product = state.get().viaQualified * state.get().viaUnqualified;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 product;\nuint64 viaQualified;\nuint64 viaUnqualified;\nuint64 calls;",
                        body: `
                            output.product = state.get().product;
                            output.viaQualified = state.get().viaQualified;
                            output.viaUnqualified = state.get().viaUnqualified;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().product = 0;\nstate.mut().viaQualified = 0;\nstate.mut().viaUnqualified = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsEnumConstantQualifiedControl",
        family: "namespaces",
        solidity: `${SOL}/scoping/name_shadowing.sol`,
        stresses:
            "the control for F205: the same enum constant that a member hides, reached through its enum's qualified name, which both backends must accept and agree on",
        caveat: "F205 is the unqualified spelling of this contract. Keeping the qualified one as a separate archetype means a fix for F205 can be checked against a row that was always green.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsEnumConstantQualifiedControl",
                header: {
                    archetype: "NsEnumConstantQualifiedControl",
                    family: "namespaces",
                    solidity: `${SOL}/scoping/name_shadowing.sol`,
                    stresses: "an enum constant hidden by a member, reached by qualification",
                    caveat: "control for F205",
                    axis: "qualified enum constant",
                },
                prelude: "namespace Port\n{\nenum Kind { Helper = 3, Other = 4 };\n}",
                state: "uint64 kind;\nuint64 other;\nuint64 helperCalls;",
                entries: [
                    {
                        name: "Helper",
                        kind: "function",
                        visibility: "private",
                        number: 0,
                        input: "uint64 value;",
                        output: "uint64 doubled;",
                        body: "output.doubled = input.value * 2;",
                    },
                    {
                        name: "Assign",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "Helper_input request;\nHelper_output reply;",
                        body: `
                            locals.request.value = input.seed;
                            CALL(Helper, locals.request, locals.reply);
                            state.mut().helperCalls += locals.reply.doubled;
                            // Qualified, so the member of the same name cannot hide it.
                            state.mut().kind = (uint64)Port::Helper;
                            state.mut().other = (uint64)Port::Other;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 kind;\nuint64 other;\nuint64 helperCalls;",
                        body: "output.kind = state.get().kind;\noutput.other = state.get().other;\noutput.helperCalls = state.get().helperCalls;",
                    },
                ],
                initialize: "state.mut().kind = 0;\nstate.mut().other = 0;\nstate.mut().helperCalls = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsLocalsMemberNamedLikeNamespace",
        family: "namespaces",
        solidity: `${SOL}/scoping/name_shadowing.sol`,
        stresses: "a `_locals` member whose name is also a namespace in scope, with a qualified use of that namespace in the same body",
        caveat: "Solidity has no namespaces to collide with; the shape comes from a library name shadowed by a local.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsLocalsMemberNamedLikeNamespace",
                header: {
                    archetype: "NsLocalsMemberNamedLikeNamespace",
                    family: "namespaces",
                    solidity: `${SOL}/scoping/name_shadowing.sol`,
                    stresses: "a locals member named like a namespace",
                    caveat: "library-name shadowing in the original",
                    axis: "locals versus namespace",
                },
                prelude: "namespace Port\n{\nstatic constexpr uint64 base = 1000;\nstruct Config\n{\n    uint64 limit;\n};\n}",
                state: "uint64 fromLocal;\nuint64 fromNamespace;\nuint64 calls;",
                entries: [
                    {
                        name: "Use",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 Port;\nPort::Config config;",
                        body: `
                            locals.Port = input.value + 1;
                            locals.config.limit = Port::base;
                            state.mut().fromLocal = locals.Port;
                            state.mut().fromNamespace = locals.config.limit;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 fromLocal;\nuint64 fromNamespace;\nuint64 calls;",
                        body: "output.fromLocal = state.get().fromLocal;\noutput.fromNamespace = state.get().fromNamespace;\noutput.calls = state.get().calls;",
                    },
                ],
                initialize: "state.mut().fromLocal = 0;\nstate.mut().fromNamespace = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsSizeofTwinStructsCompared",
        family: "namespaces",
        solidity: `${SOL}/libraries/library_struct_size.sol`,
        stresses:
            "sizeof of two same-named structs from two namespaces, compared inside the contract — a compile-time value that differs between the twins, so a mis-resolution changes a number the digest carries",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsSizeofTwinStructsCompared",
                header: {
                    archetype: "NsSizeofTwinStructsCompared",
                    family: "namespaces",
                    solidity: `${SOL}/libraries/library_struct_size.sol`,
                    stresses: "sizeof across twin structs",
                    axis: "twin sizeof",
                },
                prelude:
                    "namespace Alpha\n{\nstruct Record\n{\n    uint64 a;\n    uint8 b;\n};\n}\n\nnamespace Beta\n{\nstruct Record\n{\n    uint8 a;\n    uint64 b;\n    uint8 c;\n};\n}",
                state: "uint64 alphaSize;\nuint64 betaSize;\nuint64 difference;\nuint64 equal;\nuint64 calls;",
                entries: [
                    {
                        name: "Measure",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "Alpha::Record alpha;\nBeta::Record beta;",
                        body: `
                            locals.alpha.a = input.value;
                            locals.alpha.b = (uint8)input.value;
                            locals.beta.a = (uint8)input.value;
                            locals.beta.b = input.value;
                            locals.beta.c = (uint8)(input.value + 1);
                            state.mut().alphaSize = sizeof(Alpha::Record);
                            state.mut().betaSize = sizeof(Beta::Record);
                            state.mut().difference = state.get().betaSize - state.get().alphaSize;
                            state.mut().equal = state.get().alphaSize == state.get().betaSize ? 1 : 0;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 alphaSize;\nuint64 betaSize;\nuint64 difference;\nuint64 equal;\nuint64 calls;",
                        body: `
                            output.alphaSize = state.get().alphaSize;
                            output.betaSize = state.get().betaSize;
                            output.difference = state.get().difference;
                            output.equal = state.get().equal;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize:
                    "state.mut().alphaSize = 0;\nstate.mut().betaSize = 0;\nstate.mut().difference = 0;\nstate.mut().equal = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsGlobalScopeQualifier",
        family: "namespaces",
        solidity: `${SOL}/constants/constant_variables.sol`,
        stresses:
            "the global-scope qualifier `::name`, which is how C++ reaches a file-scope name that something nearer hides — legal C++ that clang compiles and the TypeScript backend's parser refuses",
        caveat: "Documented divergence, pinned deliberately. The contract also uses the namespace-qualified spelling next to it, so the row proves the parser accepts `Port::threshold` and refuses `::threshold` in the same file.",
        axes: ["placement"],
        expectedVerdict: "one-side-rejected",
        divergenceNote:
            "F209 — the TypeScript backend's parser rejects the global-scope qualifier `::name` (Expected expression but got d_colon); clang accepts it and compiles the contract.",
        build(axis) {
            const source = emitContract({
                axis,
                name: "NsGlobalScopeQualifier",
                header: {
                    archetype: "NsGlobalScopeQualifier",
                    family: "namespaces",
                    solidity: `${SOL}/constants/constant_variables.sol`,
                    stresses: "the global-scope qualifier next to the namespace-qualified spelling",
                    caveat: "documented divergence: the TypeScript backend refuses `::name`, clang accepts it",
                    axis: "global-scope qualifier",
                },
                prelude: "static constexpr uint64 threshold = 7;\n\nnamespace Port\n{\nstatic constexpr uint64 threshold = 100;\n}",
                state: "uint64 viaGlobalQualifier;\nuint64 viaNamespace;\nuint64 calls;",
                entries: [
                    {
                        name: "Compare",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.value;
                            state.mut().viaGlobalQualifier = locals.scratch > ::threshold ? 1 : 0;
                            state.mut().viaNamespace = locals.scratch > Port::threshold ? 1 : 0;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 viaGlobalQualifier;\nuint64 viaNamespace;\nuint64 calls;",
                        body: `
                            output.viaGlobalQualifier = state.get().viaGlobalQualifier;
                            output.viaNamespace = state.get().viaNamespace;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().viaGlobalQualifier = 0;\nstate.mut().viaNamespace = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },
];
