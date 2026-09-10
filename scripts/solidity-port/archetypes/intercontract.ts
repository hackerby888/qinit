// Cross-contract calls.
//
// Ported from Solidity's `functionCall/*` and `libraries/external_call_*`. QPI's call graph is a strict
// DAG by slot — `CALL_OTHER_CONTRACT_FUNCTION` static_asserts `callee_index < caller_index` — so there is
// no reentrancy, no delegatecall and no self-call. What survives from the Solidity originals is the part
// that still bites: the caller's and callee's views of the argument struct must agree byte for byte, a
// callee's output shorter than the caller expects must read as zeros rather than garbage, and a callee's
// state is where the mutation lands even when the caller's own state is untouched.
//
// Three rules the generator enforces, each of which would otherwise manufacture a false finding:
//   - the callee always sits at caller-1, because clang rejects a wrong ordering at compile time while
//     the TypeScript backend accepts it and returns CALL_ERROR_CONTRACT_INACTIVE at runtime;
//   - callee-declared types never appear in the caller's public input or output (`qpi/public-callee-type`
//     is a hard gate on both backends) — they live in `_locals`;
//   - at most one plain CALL/INVOKE per scope, since the macro declares its own error variable and a
//     second one in the same scope is a redefinition.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/functionCall";

export const CALLER_SLOT = 29;
export const CALLEE_SLOT = 28;

/** The callee every archetype here calls: a small ledger with one function and one procedure. */
function ledgerCallee(name: string, axis: AxisAssignment): { name: string; source: string; slot: number } {
    const source = emitContract({
        axis,
        name,
        header: {
            archetype: name,
            family: "intercontract",
            solidity: `${SOL}/external_call.sol`,
            stresses: "the callee half of a cross-contract pair: it holds the state the caller mutates through the DAG",
            axis: "callee",
        },
        state: "uint64 total;\nuint64 calls;\nuint64 lastAmount;",
        entries: [
            {
                name: "Add",
                kind: "procedure",
                number: 1,
                input: "uint64 amount;\nuint32 tag;\nuint8 flag;",
                output: "uint64 accepted;",
                locals: "uint64 scratch;",
                body: `
                    locals.scratch = input.amount;
                    if (input.flag != 0)
                    {
                        locals.scratch = locals.scratch * 2;
                    }
                    state.mut().total += locals.scratch;
                    state.mut().lastAmount = locals.scratch + (uint64)input.tag;
                    state.mut().calls++;
                    output.accepted = locals.scratch;
                `,
            },
            {
                name: "Total",
                kind: "function",
                number: 1,
                output: "uint64 total;\nuint64 calls;\nuint64 lastAmount;",
                body: "output.total = state.get().total;\noutput.calls = state.get().calls;\noutput.lastAmount = state.get().lastAmount;",
            },
        ],
        initialize: "state.mut().total = 0;\nstate.mut().calls = 0;\nstate.mut().lastAmount = 0;",
    });
    return { name, source, slot: CALLEE_SLOT };
}

function drivePairs(pairs: [bigint, bigint, bigint][]): CallStep[] {
    const steps: CallStep[] = [];
    for (const [amount, tag, flag] of pairs) {
        steps.push({ kind: "procedure", entry: 1, in: u64(amount) + u64(tag) + u64(flag), invocator: 0, note: `amount ${amount} tag ${tag} flag ${flag}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

const PAIRS: [bigint, bigint, bigint][] = [
    [1n, 7n, 0n],
    [1000n, 0n, 1n],
    [0n, 4294967295n, 0n],
    [18446744073709551615n, 1n, 1n],
];

export const INTERCONTRACT_ARCHETYPES: Archetype[] = [
    {
        name: "CalleeStructInputPacking",
        family: "intercontract",
        solidity: `${SOL}/external_call.sol`,
        stresses: "the argument struct crossing the call boundary: uint64 + uint32 + uint8 with its padding, laid out identically on both sides or the callee reads the wrong field",
        caveat: "The callee's types stay in the caller's `_locals`; a callee type in a public input is a hard gate error on both backends.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const callee = ledgerCallee("PackLedger", axis);
            const source = emitContract({
                axis,
                name: "CalleeStructInputPacking",
                header: {
                    archetype: "CalleeStructInputPacking",
                    family: "intercontract",
                    solidity: `${SOL}/external_call.sol`,
                    stresses: "mixed-width argument struct across the call boundary",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 lastAccepted;\nuint64 invocations;",
                statePlacement: axis.placement,
                temporaries: axis.temporaries,
                entries: [
                    {
                        name: "Forward",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 tag;\nuint64 flag;",
                        locals: "PackLedger::Add_input request;\nPackLedger::Add_output reply;",
                        body: `
                            locals.request.amount = input.amount;
                            locals.request.tag = (uint32)input.tag;
                            locals.request.flag = (uint8)input.flag;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(PackLedger, Add, locals.request, locals.reply, 0);
                            state.mut().lastAccepted = locals.reply.accepted;
                            state.mut().invocations++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 lastAccepted;\nuint64 invocations;",
                        body: "output.lastAccepted = state.get().lastAccepted;\noutput.invocations = state.get().invocations;",
                    },
                ],
                initialize: "state.mut().lastAccepted = 0;\nstate.mut().invocations = 0;",
            });
            return { source, script: script(drivePairs(PAIRS)), callee };
        },
    },

    {
        name: "CalleeStateIsWhereMutationLands",
        family: "intercontract",
        solidity: `${SOL}/calling_other_functions.sol`,
        stresses: "a caller that barely changes its own state while driving the callee's — the case where comparing only the caller's digest would report a false match",
        axes: ["placement"],
        build(axis) {
            const callee = ledgerCallee("SinkLedger", axis);
            const source = emitContract({
                axis,
                name: "CalleeStateIsWhereMutationLands",
                header: {
                    archetype: "CalleeStateIsWhereMutationLands",
                    family: "intercontract",
                    solidity: `${SOL}/calling_other_functions.sol`,
                    stresses: "mutation confined to the callee",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 unused;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Push",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 tag;\nuint64 flag;",
                        locals: "SinkLedger::Add_input request;\nSinkLedger::Add_output reply;",
                        body: `
                            locals.request.amount = input.amount;
                            locals.request.tag = (uint32)input.tag;
                            locals.request.flag = (uint8)input.flag;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(SinkLedger, Add, locals.request, locals.reply, 0);
                        `,
                    },
                    {
                        name: "Peek",
                        kind: "function",
                        number: 1,
                        output: "uint64 total;\nuint64 calls;",
                        locals: "SinkLedger::Total_input query;\nSinkLedger::Total_output answer;",
                        body: `
                            CALL_OTHER_CONTRACT_FUNCTION(SinkLedger, Total, locals.query, locals.answer);
                            output.total = locals.answer.total;
                            output.calls = locals.answer.calls;
                        `,
                    },
                ],
                initialize: "state.mut().unused = 0;",
            });
            return { source, script: script(drivePairs(PAIRS)), callee };
        },
    },

    {
        name: "CalleeCalledTwiceSameProcedure",
        family: "intercontract",
        solidity: `${SOL}/calling_other_functions.sol`,
        stresses: "two invocations of the same callee inside one procedure — the callee's locals must not leak from the first into the second",
        caveat: "Each call is wrapped in its own block: the plain macro declares an error variable in the enclosing scope, and two in one scope is a redefinition on both backends.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const callee = ledgerCallee("TwiceLedger", axis);
            const source = emitContract({
                axis,
                name: "CalleeCalledTwiceSameProcedure",
                header: {
                    archetype: "CalleeCalledTwiceSameProcedure",
                    family: "intercontract",
                    solidity: `${SOL}/calling_other_functions.sol`,
                    stresses: "two calls to one callee in one entry",
                    caveat: "each call braced so the macro's error variable does not collide",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 firstAccepted;\nuint64 secondAccepted;",
                statePlacement: axis.placement,
                temporaries: axis.temporaries,
                entries: [
                    {
                        name: "Twice",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 tag;\nuint64 flag;",
                        locals: "TwiceLedger::Add_input request;\nTwiceLedger::Add_output reply;",
                        body: `
                            locals.request.amount = input.amount;
                            locals.request.tag = (uint32)input.tag;
                            locals.request.flag = (uint8)input.flag;
                            {
                                INVOKE_OTHER_CONTRACT_PROCEDURE(TwiceLedger, Add, locals.request, locals.reply, 0);
                            }
                            state.mut().firstAccepted = locals.reply.accepted;
                            locals.request.amount = input.amount + 1;
                            {
                                INVOKE_OTHER_CONTRACT_PROCEDURE(TwiceLedger, Add, locals.request, locals.reply, 0);
                            }
                            state.mut().secondAccepted = locals.reply.accepted;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 firstAccepted;\nuint64 secondAccepted;",
                        body: "output.firstAccepted = state.get().firstAccepted;\noutput.secondAccepted = state.get().secondAccepted;",
                    },
                ],
                initialize: "state.mut().firstAccepted = 0;\nstate.mut().secondAccepted = 0;",
            });
            return { source, script: script(drivePairs(PAIRS)), callee };
        },
    },

    {
        name: "CalleeOutputPartiallySet",
        family: "intercontract",
        solidity: `${SOL}/multiple_return_values.sol`,
        stresses: "a callee that writes only some of its output fields — the rest must read as zeros on the caller's side, not as whatever was in the buffer",
        axes: ["placement"],
        build(axis) {
            const calleeName = "PartialLedger";
            const calleeSource = emitContract({
                axis,
                name: calleeName,
                header: {
                    archetype: calleeName,
                    family: "intercontract",
                    solidity: `${SOL}/multiple_return_values.sol`,
                    stresses: "a callee leaving output fields unwritten",
                    axis: "callee",
                },
                state: "uint64 calls;",
                entries: [
                    {
                        name: "Partial",
                        kind: "function",
                        number: 1,
                        input: "uint64 which;",
                        // Three fields; the body sets at most one of them.
                        output: "uint64 first;\nuint64 second;\nuint64 third;",
                        body: `
                            if (input.which == 0)
                            {
                                output.first = 111;
                            }
                            if (input.which == 1)
                            {
                                output.second = 222;
                            }
                        `,
                    },
                ],
                initialize: "state.mut().calls = 0;",
            });
            const source = emitContract({
                axis,
                name: "CalleeOutputPartiallySet",
                header: {
                    archetype: "CalleeOutputPartiallySet",
                    family: "intercontract",
                    solidity: `${SOL}/multiple_return_values.sol`,
                    stresses: "unwritten callee output fields",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 first;\nuint64 second;\nuint64 third;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Fetch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 which;\nuint64 unused;\nuint64 alsoUnused;",
                        locals: `${calleeName}::Partial_input query;\n${calleeName}::Partial_output answer;`,
                        body: `
                            locals.query.which = input.which;
                            CALL_OTHER_CONTRACT_FUNCTION(${calleeName}, Partial, locals.query, locals.answer);
                            state.mut().first = locals.answer.first;
                            state.mut().second = locals.answer.second;
                            state.mut().third = locals.answer.third;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 first;\nuint64 second;\nuint64 third;",
                        body: "output.first = state.get().first;\noutput.second = state.get().second;\noutput.third = state.get().third;",
                    },
                ],
                initialize: "state.mut().first = 0;\nstate.mut().second = 0;\nstate.mut().third = 0;",
            });
            return { source, script: script(drivePairs(PAIRS)), callee: { name: calleeName, source: calleeSource, slot: CALLEE_SLOT } };
        },
    },

    {
        name: "CalleeSharedStructDefinition",
        family: "intercontract",
        solidity: "test/libsolidity/semanticTests/multiSource/",
        stresses: "the same struct declared independently in both contracts: their layouts must agree, or the value the caller sends is not the value the callee reads",
        caveat: "The highest-severity shape in this family — a layout disagreement across the boundary is silent on both sides.",
        axes: ["layout", "placement"],
        build(axis) {
            const shared = [
                "struct Envelope",
                "{",
                "    uint64 wide;",
                "    uint32 medium;",
                "    uint8 tiny;",
                "};",
            ].join("\n");
            const calleeName = "EnvelopeLedger";
            const calleeSource = emitContract({
                axis,
                name: calleeName,
                header: {
                    archetype: calleeName,
                    family: "intercontract",
                    solidity: "multiSource/",
                    stresses: "the callee's own copy of a shared struct definition",
                    axis: "callee",
                },
                prelude: shared,
                state: "uint64 sum;\nuint64 calls;",
                entries: [
                    {
                        name: "Accept",
                        kind: "procedure",
                        number: 1,
                        input: "Envelope envelope;",
                        output: "uint64 echoed;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = input.envelope.wide + (uint64)input.envelope.medium + (uint64)input.envelope.tiny;
                            state.mut().sum += locals.scratch;
                            state.mut().calls++;
                            output.echoed = locals.scratch;
                        `,
                    },
                ],
                initialize: "state.mut().sum = 0;\nstate.mut().calls = 0;",
            });
            const source = emitContract({
                axis,
                name: "CalleeSharedStructDefinition",
                header: {
                    archetype: "CalleeSharedStructDefinition",
                    family: "intercontract",
                    solidity: "multiSource/",
                    stresses: "a struct defined identically in caller and callee",
                    axis: `layout=${axis.layout ?? "declared"} placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 echoed;\nuint64 envelopeSize;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Send",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 wide;\nuint64 medium;\nuint64 tiny;",
                        locals: `${calleeName}::Accept_input request;\n${calleeName}::Accept_output reply;`,
                        body: `
                            locals.request.envelope.wide = input.wide;
                            locals.request.envelope.medium = (uint32)input.medium;
                            locals.request.envelope.tiny = (uint8)input.tiny;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(${calleeName}, Accept, locals.request, locals.reply, 0);
                            state.mut().echoed = locals.reply.echoed;
                            state.mut().envelopeSize = sizeof(locals.request.envelope);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 echoed;\nuint64 envelopeSize;",
                        body: "output.echoed = state.get().echoed;\noutput.envelopeSize = state.get().envelopeSize;",
                    },
                ],
                initialize: "state.mut().echoed = 0;\nstate.mut().envelopeSize = 0;",
            });
            return { source, script: script(drivePairs(PAIRS)), callee: { name: calleeName, source: calleeSource, slot: CALLEE_SLOT } };
        },
    },

    {
        name: "CalleeInvokedWithReward",
        family: "intercontract",
        solidity: `${SOL}/external_call_value.sol`,
        stresses: "an invocation carrying QU: the reward moves between the two slots and fires the callee's POST_INCOMING_TRANSFER, so both slots' state changes from one call",
        caveat: "Solidity's `call{value:}`; the caller has to be funded for the transfer to happen at all.",
        axes: ["placement"],
        build(axis) {
            const calleeName = "RewardLedger";
            const calleeSource = emitContract({
                axis,
                name: calleeName,
                header: {
                    archetype: calleeName,
                    family: "intercontract",
                    solidity: `${SOL}/external_call_value.sol`,
                    stresses: "a callee observing an incoming transfer",
                    axis: "callee",
                },
                state: "sint64 received;\nuint64 transfers;\nuint64 calls;",
                entries: [
                    {
                        name: "Touch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        output: "uint64 seen;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().received += qpi.invocationReward();
                            state.mut().calls++;
                            output.seen = (uint64)state.get().received;
                        `,
                    },
                ],
                initialize: "state.mut().received = 0;\nstate.mut().transfers = 0;\nstate.mut().calls = 0;",
                // Every incoming transfer is counted, so the reward's path is visible in the callee's state.
                beginTick: "state.mut().transfers = state.get().transfers;",
            });
            const source = emitContract({
                axis,
                name: "CalleeInvokedWithReward",
                header: {
                    archetype: "CalleeInvokedWithReward",
                    family: "intercontract",
                    solidity: `${SOL}/external_call_value.sol`,
                    stresses: "a reward attached to a cross-contract invocation",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "uint64 seen;\nsint64 ownReward;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Pay",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 unused;\nuint64 alsoUnused;",
                        locals: `${calleeName}::Touch_input request;\n${calleeName}::Touch_output reply;\nsint64 reward;`,
                        body: `
                            locals.reward = qpi.invocationReward();
                            state.mut().ownReward += locals.reward;
                            locals.request.amount = input.amount;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(${calleeName}, Touch, locals.request, locals.reply, 1000);
                            state.mut().seen = locals.reply.seen;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 seen;\nsint64 ownReward;",
                        body: "output.seen = state.get().seen;\noutput.ownReward = state.get().ownReward;",
                    },
                ],
                initialize: "state.mut().seen = 0;\nstate.mut().ownReward = 0;",
            });
            const steps: CallStep[] = [];
            for (const amount of ["0", "5000", "1"]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(1) + u64(0) + u64(0), invocator: 0, amount, note: `reward ${amount}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps), callee: { name: calleeName, source: calleeSource, slot: CALLEE_SLOT } };
        },
    },
];
