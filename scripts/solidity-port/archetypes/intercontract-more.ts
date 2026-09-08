// Cross-contract calls, third batch: what crosses the boundary and what the caller does with it.
//
// Rounds 2 to 4 built the pair machinery, varied where the call sits, and put a container in the callee.
// What is left is the *argument and return traffic*: a struct with padding, an id, an array, a status
// code the caller branches on, a call whose result feeds the next call, and a call made from inside a
// guard that may not run at all. Both slots' digests are compared on every row, which is the only way
// the callee-side half of any of this is visible.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import { CALLEE_SLOT } from "./intercontract";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/functionCall";

/** A callee that accepts a mixed-width struct, an id and an array, and reports what it received. */
function echoCallee(name: string, axis: AxisAssignment): { name: string; source: string; slot: number } {
    const source = emitContract({
        axis,
        name,
        header: {
            archetype: name,
            family: "intercontract",
            solidity: `${SOL}/external_call.sol`,
            stresses: "the callee half: it records the bytes it was handed, so the caller's marshalling is visible in the callee's own state",
            axis: "callee",
        },
        state: "uint64 lastAmount;\nuint32 lastTag;\nuint8 lastFlag;\nuint64 idFirstWord;\nuint64 arraySum;\nuint64 calls;\nuint64 rejects;",
        entries: [
            {
                name: "Accept",
                kind: "procedure",
                number: 1,
                input: "uint64 amount;\nuint32 tag;\nuint8 flag;\nid who;\nArray<uint64, 4> values;",
                output: "uint64 accepted;\nuint64 sum;",
                locals: "uint64 i;\nuint64 sum;",
                body: `
                    locals.sum = 0;
                    for (locals.i = 0; locals.i < 4; locals.i++)
                    {
                        locals.sum += input.values.get(locals.i);
                    }
                    if (input.flag > 1)
                    {
                        state.mut().rejects++;
                        output.accepted = 0;
                        output.sum = locals.sum;
                        return;
                    }
                    state.mut().lastAmount = input.amount;
                    state.mut().lastTag = input.tag;
                    state.mut().lastFlag = input.flag;
                    state.mut().idFirstWord = input.who.u64._0;
                    state.mut().arraySum = locals.sum;
                    state.mut().calls++;
                    output.accepted = 1;
                    output.sum = locals.sum;
                `,
            },
            {
                name: "Report",
                kind: "function",
                number: 1,
                output: "uint64 lastAmount;\nuint32 lastTag;\nuint8 lastFlag;\nuint64 idFirstWord;\nuint64 arraySum;\nuint64 calls;\nuint64 rejects;",
                body: `
                    output.lastAmount = state.get().lastAmount;
                    output.lastTag = state.get().lastTag;
                    output.lastFlag = state.get().lastFlag;
                    output.idFirstWord = state.get().idFirstWord;
                    output.arraySum = state.get().arraySum;
                    output.calls = state.get().calls;
                    output.rejects = state.get().rejects;
                `,
            },
        ],
        initialize:
            "state.mut().lastAmount = 0;\nstate.mut().lastTag = 0;\nstate.mut().lastFlag = 0;\nstate.mut().idFirstWord = 0;\nstate.mut().arraySum = 0;\nstate.mut().calls = 0;\nstate.mut().rejects = 0;",
    });
    return { name, source, slot: CALLEE_SLOT };
}

interface PairSpec {
    calleeName: string;
    state: string;
    entries: Parameters<typeof emitContract>[0]["entries"];
    output: string;
    readBody: string;
    initialize: string;
    steps: CallStep[];
}

function pairArchetype(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, spec: (axis: AxisAssignment) => PairSpec): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["placement", "temporaries"],
        build(axis) {
            const shape = spec(axis);
            const callee = echoCallee(shape.calleeName, axis);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: "cross-contract traffic",
                },
                state: shape.state,
                entries: [...shape.entries, { name: "Read", kind: "function", number: 1, output: shape.output, body: shape.readBody }],
                initialize: shape.initialize,
            });
            return { source, script: script(shape.steps), callee };
        },
    };
}

export const INTERCONTRACT_MORE_ARCHETYPES: Archetype[] = [
    pairArchetype(
        {
            name: "CalleeMixedWidthStructArgument",
            family: "intercontract",
            solidity: `${SOL}/external_call.sol`,
            stresses:
                "an argument struct carrying uint64, uint32, uint8, an id and a four-element array — five members with three different alignments, marshalled into one buffer",
        },
        () => ({
            calleeName: "EchoOne",
            state: "uint64 accepted;\nuint64 sumBack;\nuint64 calls;",
            entries: [
                {
                    name: "Send",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;\nuint64 tag;\nuint64 flag;",
                    locals: "EchoOne::Accept_input request;\nEchoOne::Accept_output reply;\nuint64 i;",
                    body: `
                        locals.request.amount = input.amount;
                        locals.request.tag = (uint32)input.tag;
                        locals.request.flag = (uint8)input.flag;
                        locals.request.who = qpi.invocator();
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, input.amount + locals.i);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoOne, Accept, locals.request, locals.reply, 0);
                        state.mut().accepted += locals.reply.accepted;
                        state.mut().sumBack = locals.reply.sum;
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 accepted;\nuint64 sumBack;\nuint64 calls;",
            readBody: "output.accepted = state.get().accepted;\noutput.sumBack = state.get().sumBack;\noutput.calls = state.get().calls;",
            initialize: "state.mut().accepted = 0;\nstate.mut().sumBack = 0;\nstate.mut().calls = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(10) + u64(7) + u64(0), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(18446744073709551615n) + u64(4294967295n) + u64(1), invocator: 0, note: "every field at its maximum" },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(1) + u64(0) + u64(2), invocator: 0, note: "a flag the callee refuses" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CallerBranchesOnCalleeStatus",
            family: "intercontract",
            solidity: `${SOL}/external_call_return_value.sol`,
            stresses:
                "the caller taking a different path depending on the callee's status word, with both paths writing different members — the branch is on data that crossed a contract boundary",
        },
        () => ({
            calleeName: "EchoTwo",
            state: "uint64 acceptedPath;\nuint64 refusedPath;\nuint64 lastSum;\nuint64 calls;",
            entries: [
                {
                    name: "Try",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;\nuint64 flag;",
                    locals: "EchoTwo::Accept_input request;\nEchoTwo::Accept_output reply;\nuint64 i;",
                    body: `
                        locals.request.amount = input.amount;
                        locals.request.tag = (uint32)input.amount;
                        locals.request.flag = (uint8)input.flag;
                        locals.request.who = SELF;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, locals.i);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoTwo, Accept, locals.request, locals.reply, 0);
                        if (locals.reply.accepted != 0)
                        {
                            state.mut().acceptedPath += input.amount;
                        }
                        else
                        {
                            state.mut().refusedPath += input.amount;
                        }
                        state.mut().lastSum = locals.reply.sum;
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 acceptedPath;\nuint64 refusedPath;\nuint64 lastSum;\nuint64 calls;",
            readBody: `
                output.acceptedPath = state.get().acceptedPath;
                output.refusedPath = state.get().refusedPath;
                output.lastSum = state.get().lastSum;
                output.calls = state.get().calls;
            `,
            initialize: "state.mut().acceptedPath = 0;\nstate.mut().refusedPath = 0;\nstate.mut().lastSum = 0;\nstate.mut().calls = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(5) + u64(0), invocator: 0 },
                { kind: "procedure", entry: 1, in: u64(7) + u64(9), invocator: 0, note: "refused" },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(11) + u64(1), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CalleeResultFeedsSecondCall",
            family: "intercontract",
            solidity: `${SOL}/external_call_chain.sol`,
            stresses:
                "two calls where the second's argument is computed from the first's return — the reply buffer is read, transformed and written back into the request in the same scope",
            caveat: "The two calls sit in separate blocks: the plain macro declares its own error variable, and two in one scope collide.",
        },
        () => ({
            calleeName: "EchoThree",
            state: "uint64 firstSum;\nuint64 secondSum;\nuint64 chained;\nuint64 calls;",
            entries: [
                {
                    name: "Chain",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 seed;",
                    locals: "EchoThree::Accept_input request;\nEchoThree::Accept_output reply;\nuint64 i;",
                    body: `
                        locals.request.amount = input.seed;
                        locals.request.tag = 1;
                        locals.request.flag = 0;
                        locals.request.who = SELF;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, input.seed + locals.i);
                        }
                        {
                            INVOKE_OTHER_CONTRACT_PROCEDURE(EchoThree, Accept, locals.request, locals.reply, 0);
                            state.mut().firstSum = locals.reply.sum;
                        }
                        locals.request.amount = locals.reply.sum;
                        locals.request.tag = 2;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, locals.reply.sum + locals.i);
                        }
                        {
                            INVOKE_OTHER_CONTRACT_PROCEDURE(EchoThree, Accept, locals.request, locals.reply, 0);
                            state.mut().secondSum = locals.reply.sum;
                        }
                        state.mut().chained = state.get().secondSum - state.get().firstSum;
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 firstSum;\nuint64 secondSum;\nuint64 chained;\nuint64 calls;",
            readBody: `
                output.firstSum = state.get().firstSum;
                output.secondSum = state.get().secondSum;
                output.chained = state.get().chained;
                output.calls = state.get().calls;
            `,
            initialize: "state.mut().firstSum = 0;\nstate.mut().secondSum = 0;\nstate.mut().chained = 0;\nstate.mut().calls = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(10), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(18446744073709551615n), invocator: 0, note: "the sum wraps on the way back" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CallSkippedByGuard",
            family: "intercontract",
            solidity: `${SOL}/external_call_in_branch.sol`,
            stresses:
                "a cross-contract call behind a guard that refuses most inputs — the callee's own digest is the only evidence of whether the call happened at all",
        },
        () => ({
            calleeName: "EchoFour",
            state: "uint64 forwarded;\nuint64 blocked;\nuint64 lastSum;",
            entries: [
                {
                    name: "Maybe",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;",
                    locals: "EchoFour::Accept_input request;\nEchoFour::Accept_output reply;\nuint64 i;",
                    body: `
                        if (input.amount == 0 || input.amount > 1000)
                        {
                            state.mut().blocked++;
                            return;
                        }
                        locals.request.amount = input.amount;
                        locals.request.tag = 0;
                        locals.request.flag = 0;
                        locals.request.who = SELF;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, input.amount);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoFour, Accept, locals.request, locals.reply, 0);
                        state.mut().forwarded++;
                        state.mut().lastSum = locals.reply.sum;
                    `,
                },
            ],
            output: "uint64 forwarded;\nuint64 blocked;\nuint64 lastSum;",
            readBody: "output.forwarded = state.get().forwarded;\noutput.blocked = state.get().blocked;\noutput.lastSum = state.get().lastSum;",
            initialize: "state.mut().forwarded = 0;\nstate.mut().blocked = 0;\nstate.mut().lastSum = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0, note: "blocked" },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(500), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(1001), invocator: 0, note: "blocked" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CallInsideLoopAccumulatingReplies",
            family: "intercontract",
            solidity: `${SOL}/external_call_in_loop.sol`,
            stresses:
                "four calls in a loop whose replies are summed — the request buffer is reused, so a field the callee does not overwrite carries into the next iteration",
        },
        () => ({
            calleeName: "EchoFive",
            state: "uint64 totalSum;\nuint64 iterations;\nuint64 accepted;",
            entries: [
                {
                    name: "Fan",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 count;",
                    locals: "EchoFive::Accept_input request;\nEchoFive::Accept_output reply;\nuint64 i;\nuint64 j;\nuint64 bounded;",
                    body: `
                        locals.bounded = input.count > 4 ? 4 : input.count;
                        locals.request.who = SELF;
                        locals.request.flag = 0;
                        for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                        {
                            locals.request.amount = locals.i + 1;
                            locals.request.tag = (uint32)locals.i;
                            for (locals.j = 0; locals.j < 4; locals.j++)
                            {
                                locals.request.values.set(locals.j, locals.i * 10 + locals.j);
                            }
                            INVOKE_OTHER_CONTRACT_PROCEDURE(EchoFive, Accept, locals.request, locals.reply, 0);
                            state.mut().totalSum += locals.reply.sum;
                            state.mut().accepted += locals.reply.accepted;
                            state.mut().iterations++;
                        }
                    `,
                },
            ],
            output: "uint64 totalSum;\nuint64 iterations;\nuint64 accepted;",
            readBody: "output.totalSum = state.get().totalSum;\noutput.iterations = state.get().iterations;\noutput.accepted = state.get().accepted;",
            initialize: "state.mut().totalSum = 0;\nstate.mut().iterations = 0;\nstate.mut().accepted = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(4), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(100), invocator: 0, note: "clamped to four" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CalleeSeesCallerAsInvocator",
            family: "intercontract",
            solidity: `${SOL}/external_call_msg_sender.sol`,
            stresses:
                "the identity the callee records — it is handed the caller's own id in the argument, and the invocator it sees is the calling contract rather than the user",
            caveat: "In Solidity the callee's msg.sender is the calling contract too; what differs is that QPI's originator still names the user, so the port stores both.",
        },
        () => ({
            calleeName: "EchoSix",
            state: "uint64 userWord;\nuint64 selfWord;\nuint64 calls;",
            entries: [
                {
                    name: "Forward",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "EchoSix::Accept_input request;\nEchoSix::Accept_output reply;\nuint64 i;\nid caller;\nid own;",
                    body: `
                        locals.caller = qpi.invocator();
                        locals.request.amount = 1;
                        locals.request.tag = 0;
                        locals.request.flag = 0;
                        locals.request.who = locals.caller;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, 0);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoSix, Accept, locals.request, locals.reply, 0);
                        state.mut().userWord = locals.caller.u64._0;
                        // Copied first: a member read on the SELF constant itself is refused by the
                        // TypeScript backend (F215), and this archetype is about the callee's view.
                        locals.own = SELF;
                        state.mut().selfWord = locals.own.u64._0;
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 userWord;\nuint64 selfWord;\nuint64 calls;",
            readBody: "output.userWord = state.get().userWord;\noutput.selfWord = state.get().selfWord;\noutput.calls = state.get().calls;",
            initialize: "state.mut().userWord = 0;\nstate.mut().selfWord = 0;\nstate.mut().calls = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(0), invocator: 1, note: "a different user" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CalleeArraySumCrossChecked",
            family: "intercontract",
            solidity: `${SOL}/external_call_array_argument.sol`,
            stresses:
                "a four-element array crossing the boundary, summed by the callee and again by the caller — the two sums must agree, which they only do if all four elements arrived",
        },
        () => ({
            calleeName: "EchoSeven",
            state: "uint64 calleeSum;\nuint64 callerSum;\nuint64 mismatches;\nuint64 calls;",
            entries: [
                {
                    name: "Send",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 base;",
                    locals: "EchoSeven::Accept_input request;\nEchoSeven::Accept_output reply;\nuint64 i;\nuint64 mine;",
                    body: `
                        locals.mine = 0;
                        locals.request.amount = input.base;
                        locals.request.tag = 0;
                        locals.request.flag = 0;
                        locals.request.who = SELF;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, input.base * (locals.i + 1));
                            locals.mine += input.base * (locals.i + 1);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoSeven, Accept, locals.request, locals.reply, 0);
                        state.mut().calleeSum = locals.reply.sum;
                        state.mut().callerSum = locals.mine;
                        if (locals.reply.sum != locals.mine)
                        {
                            state.mut().mismatches++;
                        }
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 calleeSum;\nuint64 callerSum;\nuint64 mismatches;\nuint64 calls;",
            readBody: `
                output.calleeSum = state.get().calleeSum;
                output.callerSum = state.get().callerSum;
                output.mismatches = state.get().mismatches;
                output.calls = state.get().calls;
            `,
            initialize: "state.mut().calleeSum = 0;\nstate.mut().callerSum = 0;\nstate.mut().mismatches = 0;\nstate.mut().calls = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0 },
                { kind: "procedure", entry: 1, in: u64(7), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(4611686018427387904n), invocator: 0, note: "the sums wrap identically on both sides" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CallWithRewardThenWithout",
            family: "intercontract",
            solidity: `${SOL}/external_call_value.sol`,
            stresses:
                "the same invocation made with a reward and then without — the callee's behaviour must not change, and the caller's own balance accounting must",
        },
        () => ({
            calleeName: "EchoEight",
            state: "sint64 rewardIn;\nuint64 withReward;\nuint64 withoutReward;\nuint64 calls;",
            entries: [
                {
                    name: "Pay",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;\nsint64 forwardAmount;",
                    locals: "EchoEight::Accept_input request;\nEchoEight::Accept_output reply;\nuint64 i;",
                    body: `
                        state.mut().rewardIn += qpi.invocationReward();
                        locals.request.amount = input.amount;
                        locals.request.tag = 0;
                        locals.request.flag = 0;
                        locals.request.who = SELF;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, input.amount);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoEight, Accept, locals.request, locals.reply, input.forwardAmount);
                        if (input.forwardAmount > 0)
                        {
                            state.mut().withReward++;
                        }
                        else
                        {
                            state.mut().withoutReward++;
                        }
                        state.mut().calls++;
                    `,
                },
            ],
            output: "sint64 rewardIn;\nuint64 withReward;\nuint64 withoutReward;\nuint64 calls;",
            readBody: `
                output.rewardIn = state.get().rewardIn;
                output.withReward = state.get().withReward;
                output.withoutReward = state.get().withoutReward;
                output.calls = state.get().calls;
            `,
            initialize: "state.mut().rewardIn = 0;\nstate.mut().withReward = 0;\nstate.mut().withoutReward = 0;\nstate.mut().calls = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(10) + u64(0), invocator: 0, amount: "0" },
                { kind: "procedure", entry: 1, in: u64(10) + u64(50), invocator: 0, amount: "100" },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(10) + u64(1000000), invocator: 0, note: "more than the caller holds" },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CalleeStateReadBackByFunction",
            family: "intercontract",
            solidity: `${SOL}/external_call_view.sol`,
            stresses:
                "a procedure that writes into the callee and a function that reads it straight back — a read-only cross-contract call immediately after a mutating one",
        },
        () => ({
            calleeName: "EchoNine",
            state: "uint64 writtenAmount;\nuint64 readBackAmount;\nuint64 agreements;\nuint64 calls;",
            entries: [
                {
                    name: "WriteThenRead",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;",
                    locals: "EchoNine::Accept_input request;\nEchoNine::Accept_output reply;\nEchoNine::Report_input query;\nEchoNine::Report_output answer;\nuint64 i;",
                    body: `
                        locals.request.amount = input.amount;
                        locals.request.tag = 0;
                        locals.request.flag = 0;
                        locals.request.who = SELF;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, 0);
                        }
                        {
                            INVOKE_OTHER_CONTRACT_PROCEDURE(EchoNine, Accept, locals.request, locals.reply, 0);
                            state.mut().writtenAmount = input.amount;
                        }
                        {
                            CALL_OTHER_CONTRACT_FUNCTION(EchoNine, Report, locals.query, locals.answer);
                            state.mut().readBackAmount = locals.answer.lastAmount;
                        }
                        if (state.get().readBackAmount == state.get().writtenAmount)
                        {
                            state.mut().agreements++;
                        }
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 writtenAmount;\nuint64 readBackAmount;\nuint64 agreements;\nuint64 calls;",
            readBody: `
                output.writtenAmount = state.get().writtenAmount;
                output.readBackAmount = state.get().readBackAmount;
                output.agreements = state.get().agreements;
                output.calls = state.get().calls;
            `,
            initialize: "state.mut().writtenAmount = 0;\nstate.mut().readBackAmount = 0;\nstate.mut().agreements = 0;\nstate.mut().calls = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(42), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(18446744073709551615n), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CalleeRejectionLeavesStateAlone",
            family: "intercontract",
            solidity: `${SOL}/external_call_revert.sol`,
            stresses:
                "a call the callee refuses on its own guard — its state must be unchanged apart from the refusal counter, which is only visible in the callee's digest",
            caveat: "Solidity's revert would roll the whole transaction back; QPI's callee simply returns, so the port checks that nothing else moved rather than that everything was undone.",
        },
        () => ({
            calleeName: "EchoTen",
            state: "uint64 attempts;\nuint64 accepted;\nuint64 refused;\nuint64 lastAccepted;",
            entries: [
                {
                    name: "Attempt",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;\nuint64 flag;",
                    locals: "EchoTen::Accept_input request;\nEchoTen::Accept_output reply;\nuint64 i;",
                    body: `
                        locals.request.amount = input.amount;
                        locals.request.tag = 0;
                        locals.request.flag = (uint8)input.flag;
                        locals.request.who = SELF;
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, locals.i);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoTen, Accept, locals.request, locals.reply, 0);
                        state.mut().attempts++;
                        if (locals.reply.accepted != 0)
                        {
                            state.mut().accepted++;
                            state.mut().lastAccepted = input.amount;
                        }
                        else
                        {
                            state.mut().refused++;
                        }
                    `,
                },
            ],
            output: "uint64 attempts;\nuint64 accepted;\nuint64 refused;\nuint64 lastAccepted;",
            readBody: `
                output.attempts = state.get().attempts;
                output.accepted = state.get().accepted;
                output.refused = state.get().refused;
                output.lastAccepted = state.get().lastAccepted;
            `,
            initialize: "state.mut().attempts = 0;\nstate.mut().accepted = 0;\nstate.mut().refused = 0;\nstate.mut().lastAccepted = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(5) + u64(0), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(9) + u64(5), invocator: 0, note: "refused by the callee's guard" },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(11) + u64(1), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CalleeCalledWithMaximalArguments",
            family: "intercontract",
            solidity: `${SOL}/external_call.sol`,
            stresses:
                "every argument field at its maximum in one call — the widest values that can cross the boundary, where a truncated marshalling is immediately visible in the callee's record",
        },
        () => ({
            calleeName: "EchoEleven",
            state: "uint64 sumBack;\nuint64 calls;\nuint64 acceptedCount;",
            entries: [
                {
                    name: "Max",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "EchoEleven::Accept_input request;\nEchoEleven::Accept_output reply;\nuint64 i;\nuint64 maxSeed;",
                    body: `
                        locals.request.amount = 18446744073709551615ULL;
                        locals.request.tag = 4294967295;
                        locals.request.flag = 1;
                        locals.maxSeed = 18446744073709551615ULL;
                        // Hashed from a named local: K12 of an expression is F203's territory, and this
                        // archetype is about marshalling rather than about that.
                        locals.request.who = qpi.K12(locals.maxSeed);
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, 18446744073709551615ULL);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoEleven, Accept, locals.request, locals.reply, 0);
                        state.mut().sumBack = locals.reply.sum;
                        state.mut().acceptedCount += locals.reply.accepted;
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 sumBack;\nuint64 calls;\nuint64 acceptedCount;",
            readBody: "output.sumBack = state.get().sumBack;\noutput.calls = state.get().calls;\noutput.acceptedCount = state.get().acceptedCount;",
            initialize: "state.mut().sumBack = 0;\nstate.mut().calls = 0;\nstate.mut().acceptedCount = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "procedure", entry: 1, in: u64(0), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    pairArchetype(
        {
            name: "CallerStateUnchangedByCallee",
            family: "intercontract",
            solidity: `${SOL}/external_call.sol`,
            stresses:
                "a caller that hands everything to the callee and keeps only a counter — the negative control for the pair comparison, where all the movement must be on the callee's side",
        },
        () => ({
            calleeName: "EchoTwelve",
            state: "uint64 calls;\nuint64 canary;",
            entries: [
                {
                    name: "Push",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;",
                    locals: "EchoTwelve::Accept_input request;\nEchoTwelve::Accept_output reply;\nuint64 i;",
                    body: `
                        locals.request.amount = input.amount;
                        locals.request.tag = (uint32)input.amount;
                        locals.request.flag = 0;
                        locals.request.who = qpi.invocator();
                        for (locals.i = 0; locals.i < 4; locals.i++)
                        {
                            locals.request.values.set(locals.i, input.amount + locals.i);
                        }
                        INVOKE_OTHER_CONTRACT_PROCEDURE(EchoTwelve, Accept, locals.request, locals.reply, 0);
                        state.mut().calls++;
                    `,
                },
            ],
            output: "uint64 calls;\nuint64 canary;",
            readBody: "output.calls = state.get().calls;\noutput.canary = state.get().canary;",
            initialize: "state.mut().calls = 0;\nstate.mut().canary = 12297829382473034410ULL;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(1), invocator: 0 },
                { kind: "procedure", entry: 1, in: u64(2), invocator: 0 },
                { kind: "procedure", entry: 1, in: u64(3), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),
];
