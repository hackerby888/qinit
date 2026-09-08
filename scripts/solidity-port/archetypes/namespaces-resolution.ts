// Name resolution: shadowing, overloads, qualified access and same-name declarations.
//
// Ported from Solidity's `scoping`, `inheritance`, `freeFunctions`, `using`, `constants` and `events`
// tests. Solidity has no namespaces, so these come from `library` declarations, `using L for T`,
// duplicate library type names and SWC-119 shadowing. This is the family the repo's own testing notes
// call out as having "produced nine silent bugs", so every archetype writes a number into state that
// only comes out right if the intended declaration was picked — a mis-resolution moves the digest
// instead of being absorbed.

import { emitContract } from "../emit";
import { singleProcedureArchetype } from "./common";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

function drive(values: bigint[], entry = 1): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry, in: u64(value), invocator: 0, note: `value ${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

const VALUES = [0n, 1n, 7n, 42n, 18446744073709551615n];

export const NAMESPACE_RESOLUTION_ARCHETYPES: Archetype[] = [
    singleProcedureArchetype(
        {
            name: "NsBlockShadowActivation",
            family: "namespaces",
            solidity: `${SOL}/scoping/c99_scoping_activation.sol`,
            stresses: "C99 declaration-point shadowing: an inner name is only in scope after its declaration, so the statement before it writes the outer one",
            caveat: "QPI forbids stack locals, so the two scopes are two members of the `_locals` struct reached through nested blocks rather than two declarations of one name.",
            axes: ["placement", "temporaries", "initStyle"],
        },
        () => ({
            extraState: "uint64 outerAfterBlock;\nuint64 innerInBlock;",
            input: "uint64 seed;",
            locals: "uint64 outer;\nuint64 inner;",
            body: `
                locals.outer = 7;
                {
                    // Writes here reach the outer name; the inner one only exists from its declaration on.
                    locals.outer = 3;
                    locals.inner = 4;
                }
                state.mut().outerAfterBlock = locals.outer;
                state.mut().innerInBlock = locals.inner;
                state.mut().accumulator = locals.outer * 100 + locals.inner + input.seed;
            `,
            steps: drive(VALUES),
        }),
    ),

    singleProcedureArchetype(
        {
            name: "NsMemberShadowsStateField",
            family: "namespaces",
            solidity: `${SOL}/inheritance/inherited_state.sol`,
            stresses: "a `_locals` member named exactly like a state member, written and read in the same entry — the QPI-specific form of SWC-119 shadowing",
            axes: ["placement", "temporaries"],
        },
        () => ({
            extraState: "uint64 balance;\nuint64 witness;",
            input: "uint64 amount;",
            locals: "uint64 balance;",
            body: `
                locals.balance = state.get().balance + input.amount;
                state.mut().witness = locals.balance;
                state.mut().balance = locals.balance;
                state.mut().accumulator = state.get().balance;
            `,
            steps: drive(VALUES),
        }),
    ),

    singleProcedureArchetype(
        {
            name: "NsInputFieldNamedLikeMacroArgument",
            family: "namespaces",
            solidity: `${SOL}/constructor/constructor_function_argument.sol`,
            stresses: "an input field named `state`, `output` or `locals` — the identifiers the entry macros bind, shadowed from inside the input struct",
            caveat: "No Solidity analogue for the macro binding; the parameter-shadows-field shape is the original.",
            axes: ["placement"],
        },
        () => ({
            extraState: "uint64 stored;",
            input: "uint64 qpi;\nuint64 output;",
            locals: "uint64 scratch;",
            body: `
                locals.scratch = input.qpi + input.output;
                state.mut().stored = locals.scratch;
                state.mut().accumulator = state.get().stored;
            `,
            steps: (() => {
                const steps: CallStep[] = [];
                for (const value of VALUES) {
                    steps.push({ kind: "procedure", entry: 1, in: u64(value) + u64(value + 1n), invocator: 0, note: `qpi=${value}` });
                    steps.push({ kind: "function", entry: 1 });
                }
                steps.push({ kind: "advanceTick", n: 1 });
                return steps;
            })(),
        }),
    ),

    {
        name: "NsOverloadResolveByArity",
        family: "namespaces",
        solidity: `${SOL}/inheritance/overloaded_function_call_resolve_to_first.sol`,
        stresses: "two same-named private helpers differing only in arity; each call site must pick the right one and the results must not blend",
        axes: ["placement", "entryShape"],
        build(axis) {
            const source = emitContract({
                name: "NsOverloadResolveByArity",
                header: {
                    archetype: "NsOverloadResolveByArity",
                    family: "namespaces",
                    solidity: `${SOL}/inheritance/overloaded_function_call_resolve_to_first.sol`,
                    stresses: "arity-based overload resolution",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                prelude: "namespace Helpers\n{\nstatic constexpr uint64 ONE_ARG_TAG = 100;\nstatic constexpr uint64 TWO_ARG_TAG = 200;\n}",
                state: "uint64 fromOne;\nuint64 fromTwo;\nuint64 total;",
                statePlacement: axis.placement,
                entryShape: axis.entryShape,
                entries: [
                    {
                        name: "Resolve",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 a;\nuint64 b;",
                        locals: "OneArg_input oneIn;\nOneArg_output oneOut;\nTwoArg_input twoIn;\nTwoArg_output twoOut;",
                        body: `
                            locals.oneIn.a = input.a;
                            CALL(OneArg, locals.oneIn, locals.oneOut);
                            locals.twoIn.a = input.a;
                            locals.twoIn.b = input.b;
                            CALL(TwoArg, locals.twoIn, locals.twoOut);
                            state.mut().fromOne = locals.oneOut.result;
                            state.mut().fromTwo = locals.twoOut.result;
                            state.mut().total = locals.oneOut.result + locals.twoOut.result;
                        `,
                    },
                    {
                        name: "OneArg",
                        kind: "function",
                        number: 2,
                        visibility: "private",
                        input: "uint64 a;",
                        output: "uint64 result;",
                        body: "output.result = input.a + Helpers::ONE_ARG_TAG;",
                    },
                    {
                        name: "TwoArg",
                        kind: "function",
                        number: 3,
                        visibility: "private",
                        input: "uint64 a;\nuint64 b;",
                        output: "uint64 result;",
                        body: "output.result = input.a + input.b + Helpers::TWO_ARG_TAG;",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 fromOne;\nuint64 fromTwo;\nuint64 total;",
                        body: "output.fromOne = state.get().fromOne;\noutput.fromTwo = state.get().fromTwo;\noutput.total = state.get().total;",
                    },
                ],
                initialize: "state.mut().fromOne = 0;\nstate.mut().fromTwo = 0;\nstate.mut().total = 0;",
            });
            const steps: CallStep[] = [];
            for (const value of VALUES) {
                steps.push({ kind: "procedure", entry: 1, in: u64(value) + u64(value + 3n), invocator: 0, note: `a=${value}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "NsMemberNameShadowsQpiBuiltin",
        family: "namespaces",
        solidity: `${SOL}/operators/userDefined/operator_definition_shadowing_builtin_keccak256.sol`,
        stresses: "contract members named like QPI builtins (`div`, `mod`, `tick`, `epoch`) next to real calls to `QPI::div` and `qpi.tick()` — the qualified calls must still reach the real ones",
        caveat: "Solidity's version shadows `keccak256`; the QPI equivalents are the math helpers and the context accessors.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                name: "NsMemberNameShadowsQpiBuiltin",
                header: {
                    archetype: "NsMemberNameShadowsQpiBuiltin",
                    family: "namespaces",
                    solidity: `${SOL}/operators/userDefined/operator_definition_shadowing_builtin_keccak256.sol`,
                    stresses: "members named like QPI builtins",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 div;\nuint64 mod;\nuint64 tick;\nuint64 realDiv;\nuint64 realMod;\nuint64 realTick;",
                statePlacement: axis.placement,
                temporaries: axis.temporaries,
                entries: [
                    {
                        name: "Compute",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 a;\nuint64 b;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().div = input.a;
                            state.mut().mod = input.b;
                            state.mut().tick = 99;
                            // The shadowing members above must not capture these qualified calls.
                            locals.scratch = QPI::div(input.a, input.b);
                            state.mut().realDiv = locals.scratch;
                            locals.scratch = QPI::mod(input.a, input.b);
                            state.mut().realMod = locals.scratch;
                            state.mut().realTick = (uint64)qpi.tick();
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 div;\nuint64 mod;\nuint64 tick;\nuint64 realDiv;\nuint64 realMod;\nuint64 realTick;",
                        body: `
                            output.div = state.get().div;
                            output.mod = state.get().mod;
                            output.tick = state.get().tick;
                            output.realDiv = state.get().realDiv;
                            output.realMod = state.get().realMod;
                            output.realTick = state.get().realTick;
                        `,
                    },
                ],
                initialize: "state.mut().div = 0;\nstate.mut().mod = 0;\nstate.mut().tick = 0;\nstate.mut().realDiv = 0;\nstate.mut().realMod = 0;\nstate.mut().realTick = 0;",
            });
            const steps: CallStep[] = [];
            for (const [a, b] of [
                [7n, 3n],
                [7n, 0n],
                [0n, 5n],
                [18446744073709551615n, 2n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(a) + u64(b), invocator: 0, note: `${a}, ${b}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "NsConstantSameNameTwoNamespaces",
        family: "namespaces",
        solidity: `${SOL}/constants/same_constants_different_files.sol`,
        stresses: "the same constant name declared in two namespaces with different values, both used in one expression — only the qualification distinguishes them",
        axes: ["placement", "constSource"],
        build(axis) {
            const source = emitContract({
                name: "NsConstantSameNameTwoNamespaces",
                header: {
                    archetype: "NsConstantSameNameTwoNamespaces",
                    family: "namespaces",
                    solidity: `${SOL}/constants/same_constants_different_files.sol`,
                    stresses: "same-named constants in two namespaces",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                prelude: [
                    "namespace Alpha",
                    "{",
                    "static constexpr uint64 LIMIT = 10;",
                    "static constexpr uint64 STEP = 3;",
                    "}",
                    "",
                    "namespace Beta",
                    "{",
                    "static constexpr uint64 LIMIT = 1000;",
                    "static constexpr uint64 STEP = 7;",
                    "}",
                ].join("\n"),
                state: "uint64 fromAlpha;\nuint64 fromBeta;\nuint64 mixed;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Compute",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().fromAlpha = QPI::mod(input.seed, Alpha::LIMIT) * Alpha::STEP;
                            state.mut().fromBeta = QPI::mod(input.seed, Beta::LIMIT) * Beta::STEP;
                            locals.scratch = Alpha::LIMIT * Beta::STEP + Beta::LIMIT * Alpha::STEP;
                            state.mut().mixed = locals.scratch;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 fromAlpha;\nuint64 fromBeta;\nuint64 mixed;",
                        body: "output.fromAlpha = state.get().fromAlpha;\noutput.fromBeta = state.get().fromBeta;\noutput.mixed = state.get().mixed;",
                    },
                ],
                initialize: "state.mut().fromAlpha = 0;\nstate.mut().fromBeta = 0;\nstate.mut().mixed = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsTwoStructsSameFieldNames",
        family: "namespaces",
        solidity: `${SOL}/structs/struct_referencing.sol`,
        stresses: "two distinct structs whose members have identical names, both in state and written in one entry — a field-name-keyed code path would cross them",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                name: "NsTwoStructsSameFieldNames",
                header: {
                    archetype: "NsTwoStructsSameFieldNames",
                    family: "namespaces",
                    solidity: `${SOL}/structs/struct_referencing.sol`,
                    stresses: "identical member names in two different struct types",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                prelude: [
                    "struct Narrow",
                    "{",
                    "    uint8 value;",
                    "    uint8 tag;",
                    "};",
                    "",
                    "struct Wide",
                    "{",
                    "    uint64 value;",
                    "    uint64 tag;",
                    "};",
                ].join("\n"),
                state: "Narrow narrow;\nWide wide;\nuint64 narrowSize;\nuint64 wideSize;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Write",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().narrow.value = (uint8)input.seed;
                            state.mut().narrow.tag = (uint8)(input.seed + 1);
                            state.mut().wide.value = input.seed;
                            state.mut().wide.tag = input.seed + 1;
                            state.mut().narrowSize = sizeof(Narrow);
                            state.mut().wideSize = sizeof(Wide);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 narrowValue;\nuint64 wideValue;\nuint64 narrowSize;\nuint64 wideSize;",
                        body: `
                            output.narrowValue = (uint64)state.get().narrow.value;
                            output.wideValue = state.get().wide.value;
                            output.narrowSize = state.get().narrowSize;
                            output.wideSize = state.get().wideSize;
                        `,
                    },
                ],
                initialize: "state.mut().narrowSize = 0;\nstate.mut().wideSize = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsFileLevelConstantChain",
        family: "namespaces",
        solidity: `${SOL}/constants/constants_at_file_level_referencing.sol`,
        stresses: "a namespace-scope constant initialised from another namespace-scope constant — static initialisation order, which is a real wasm-backend hazard",
        axes: ["width", "placement"],
        build(axis) {
            const width = axis.width ?? "uint64";
            const source = emitContract({
                name: "NsFileLevelConstantChain",
                header: {
                    archetype: "NsFileLevelConstantChain",
                    family: "namespaces",
                    solidity: `${SOL}/constants/constants_at_file_level_referencing.sol`,
                    stresses: "a chain of namespace-scope constants",
                    caveat: "Transitive wrap: Solidity's `uint8 B = uint8(200) + 200` reverts under 0.8; QPI wraps and the port asserts the wrapped value.",
                    axis: `width=${width}`,
                },
                prelude: [
                    "namespace Chain",
                    "{",
                    `static constexpr ${width} BASE = 200;`,
                    `static constexpr ${width} DERIVED = (${width})(BASE + 200);`,
                    `static constexpr ${width} TRANSITIVE = (${width})(DERIVED + BASE);`,
                    "}",
                ].join("\n"),
                state: `${width} base;\n${width} derived;\n${width} transitive;\nuint64 sum;`,
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Snapshot",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().base = Chain::BASE;
                            state.mut().derived = Chain::DERIVED;
                            state.mut().transitive = Chain::TRANSITIVE;
                            locals.scratch = (uint64)Chain::BASE + (uint64)Chain::DERIVED + (uint64)Chain::TRANSITIVE + input.seed;
                            state.mut().sum = locals.scratch;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: `${width} base;\n${width} derived;\n${width} transitive;\nuint64 sum;`,
                        body: `
                            output.base = state.get().base;
                            output.derived = state.get().derived;
                            output.transitive = state.get().transitive;
                            output.sum = state.get().sum;
                        `,
                    },
                ],
                initialize: "state.mut().base = 0;\nstate.mut().derived = 0;\nstate.mut().transitive = 0;\nstate.mut().sum = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },

    {
        name: "NsUnderscoreNamedMember",
        family: "namespaces",
        solidity: `${SOL}/underscore/as_function.sol`,
        stresses: "members and locals named `_` and `_x` — legal identifiers QPI does not reserve, next to the `__`-prefixed names it does",
        caveat: "QPI forbids double underscores; a single leading underscore is legal, which makes it a good adversarial name.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                name: "NsUnderscoreNamedMember",
                header: {
                    archetype: "NsUnderscoreNamedMember",
                    family: "namespaces",
                    solidity: `${SOL}/underscore/as_function.sol`,
                    stresses: "single-underscore identifiers",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 _;\nuint64 _value;\nuint64 value_;\nuint64 combined;",
                statePlacement: axis.placement,
                temporaries: axis.temporaries,
                entries: [
                    {
                        name: "Assign",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "uint64 _scratch;",
                        body: `
                            locals._scratch = input.seed;
                            state.mut()._ = locals._scratch;
                            state.mut()._value = locals._scratch + 1;
                            state.mut().value_ = locals._scratch + 2;
                            state.mut().combined = state.get()._ + state.get()._value + state.get().value_;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 combined;",
                        body: "output.combined = state.get().combined;",
                    },
                ],
                initialize: "state.mut()._ = 0;\nstate.mut()._value = 0;\nstate.mut().value_ = 0;\nstate.mut().combined = 0;",
            });
            return { source, script: script(drive(VALUES)) };
        },
    },
];
