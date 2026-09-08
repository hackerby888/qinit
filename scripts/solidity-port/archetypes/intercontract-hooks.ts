// Cross-contract calls from places the earlier rounds did not call from, and callees that hold more
// than a scalar.
//
// Round 2 built the pair machinery and round 3 varied where the call sits inside an entry. What is left
// is the two harder shapes: a call made from a *tick hook*, with no user transaction on the stack, and a
// callee whose own state is a container, so the mutation the caller causes lands in a table's internal
// bookkeeping rather than in a counter. Both are compared on the callee's digest as well as the
// caller's, which is the only way the second shape is visible at all.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import { CALLEE_SLOT } from "./intercontract";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/functionCall";

/** A callee whose state is a HashMap, so the caller's writes land in a table's occupation flags. */
function tableCallee(name: string, axis: AxisAssignment, capacity = 8): { name: string; source: string; slot: number } {
    const source = emitContract({
        axis,
        name,
        header: {
            archetype: name,
            family: "intercontract",
            solidity: `${SOL}/external_call.sol`,
            stresses: "a callee holding a HashMap, so cross-contract writes land in a table rather than a counter",
            axis: "callee",
        },
        state: `HashMap<uint64, uint64, ${capacity}> table;\nuint64 writes;\nuint64 rejected;`,
        entries: [
            {
                name: "Put",
                kind: "procedure",
                number: 1,
                input: "uint64 key;\nuint64 value;",
                output: "sint64 slot;",
                locals: "sint64 slot;",
                body: `
                    locals.slot = state.mut().table.set(input.key, input.value);
                    if (locals.slot >= 0)
                    {
                        state.mut().writes++;
                    }
                    else
                    {
                        state.mut().rejected++;
                    }
                    output.slot = locals.slot;
                `,
            },
            {
                name: "Get",
                kind: "function",
                number: 1,
                input: "uint64 key;",
                output: "uint64 value;\nuint64 present;\nuint64 population;",
                locals: "uint64 fetched;",
                body: `
                    locals.fetched = 0;
                    output.present = state.get().table.get(input.key, locals.fetched) ? 1 : 0;
                    output.value = locals.fetched;
                    output.population = state.get().table.population();
                `,
            },
        ],
        initialize: "state.mut().table.reset();\nstate.mut().writes = 0;\nstate.mut().rejected = 0;",
    });
    return { name, source, slot: CALLEE_SLOT };
}

export const INTERCONTRACT_HOOK_ARCHETYPES: Archetype[] = [
    {
        name: "CalleeTableWrittenThroughCaller",
        family: "intercontract",
        solidity: `${SOL}/external_call.sol`,
        stresses:
            "a callee whose state is a HashMap, filled to capacity and past it through the caller — the rejected write is a status code the caller stores, and the table's own bookkeeping is only visible in the callee's digest",
        axes: ["placement", "temporaries"],
        build(axis) {
            const callee = tableCallee("TableLedger", axis);
            const source = emitContract({
                axis,
                name: "CalleeTableWrittenThroughCaller",
                header: {
                    archetype: "CalleeTableWrittenThroughCaller",
                    family: "intercontract",
                    solidity: `${SOL}/external_call.sol`,
                    stresses: "cross-contract writes into a container",
                    axis: "callee holds a table",
                },
                state: "sint64 lastSlot;\nuint64 accepted;\nuint64 refused;\nuint64 lastPopulation;",
                entries: [
                    {
                        name: "Put",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nuint64 value;",
                        locals: "TableLedger::Put_input request;\nTableLedger::Put_output reply;",
                        body: `
                            locals.request.key = input.key;
                            locals.request.value = input.value;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(TableLedger, Put, locals.request, locals.reply, 0);
                            state.mut().lastSlot = locals.reply.slot;
                            if (locals.reply.slot >= 0)
                            {
                                state.mut().accepted++;
                            }
                            else
                            {
                                state.mut().refused++;
                            }
                        `,
                    },
                    {
                        name: "Sample",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 key;",
                        locals: "TableLedger::Get_input query;\nTableLedger::Get_output answer;",
                        body: `
                            locals.query.key = input.key;
                            CALL_OTHER_CONTRACT_FUNCTION(TableLedger, Get, locals.query, locals.answer);
                            state.mut().lastPopulation = locals.answer.population;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 lastSlot;\nuint64 accepted;\nuint64 refused;\nuint64 lastPopulation;",
                        body: `
                            output.lastSlot = state.get().lastSlot;
                            output.accepted = state.get().accepted;
                            output.refused = state.get().refused;
                            output.lastPopulation = state.get().lastPopulation;
                        `,
                    },
                ],
                initialize: "state.mut().lastSlot = 0;\nstate.mut().accepted = 0;\nstate.mut().refused = 0;\nstate.mut().lastPopulation = 0;",
            });
            const steps: CallStep[] = [];
            for (let key = 0; key < 10; key++) {
                steps.push({ kind: "procedure", entry: 1, in: u64(key) + u64(key * 11), invocator: 0, note: `key ${key}` });
            }
            steps.push({ kind: "procedure", entry: 2, in: u64(0), invocator: 0 });
            steps.push({ kind: "function", entry: 1 });
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps), callee };
        },
    },

    {
        name: "CalleeInvokedFromTickHook",
        family: "intercontract",
        solidity: "no Solidity analogue (per-block cross-contract call)",
        stresses:
            "the caller invoking its callee from END_TICK — a cross-contract call with no user transaction on the stack, whose effects show up in the callee's digest between two user calls",
        caveat: "Ethereum has no code that runs between transactions, so the whole shape is QPI-only.",
        axes: ["placement"],
        build(axis) {
            const callee = tableCallee("TickLedger", axis);
            const source = emitContract({
                axis,
                name: "CalleeInvokedFromTickHook",
                header: {
                    archetype: "CalleeInvokedFromTickHook",
                    family: "intercontract",
                    solidity: "no Solidity analogue",
                    stresses: "a cross-contract call made from a tick hook",
                    caveat: "no between-transaction execution in Solidity",
                    axis: "call from END_TICK",
                },
                state: "uint64 queuedKey;\nuint64 queuedValue;\nuint64 hookCalls;\nsint64 lastSlot;",
                entries: [
                    {
                        name: "Queue",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nuint64 value;",
                        locals: "uint64 scratch;",
                        body: "state.mut().queuedKey = input.key;\nstate.mut().queuedValue = input.value;",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 queuedKey;\nuint64 queuedValue;\nuint64 hookCalls;\nsint64 lastSlot;",
                        body: `
                            output.queuedKey = state.get().queuedKey;
                            output.queuedValue = state.get().queuedValue;
                            output.hookCalls = state.get().hookCalls;
                            output.lastSlot = state.get().lastSlot;
                        `,
                    },
                ],
                initialize: "state.mut().queuedKey = 0;\nstate.mut().queuedValue = 0;\nstate.mut().hookCalls = 0;\nstate.mut().lastSlot = 0;",
                endTickLocals: "TickLedger::Put_input request;\nTickLedger::Put_output reply;",
                endTick: `
                    if (state.get().queuedValue != 0)
                    {
                        locals.request.key = state.get().queuedKey;
                        locals.request.value = state.get().queuedValue;
                        INVOKE_OTHER_CONTRACT_PROCEDURE(TickLedger, Put, locals.request, locals.reply, 0);
                        state.mut().lastSlot = locals.reply.slot;
                        state.mut().queuedValue = 0;
                        state.mut().hookCalls++;
                    }
                `,
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(1) + u64(100), invocator: 0, note: "queue for the next tick" },
                    { kind: "advanceTick", n: 1 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(2) + u64(200), invocator: 0 },
                    { kind: "advanceTick", n: 2 },
                    { kind: "function", entry: 1 },
                ]),
                callee,
            };
        },
    },

    {
        name: "CalleeOutputPartiallyRead",
        family: "intercontract",
        solidity: `${SOL}/external_call_return_struct.sol`,
        stresses:
            "a callee whose output struct has three members of which the caller reads one — the other two still cross the boundary and still have to be written, which a truncated copy would hide",
        axes: ["placement", "temporaries"],
        build(axis) {
            const callee = tableCallee("WideLedger", axis);
            const source = emitContract({
                axis,
                name: "CalleeOutputPartiallyRead",
                header: {
                    archetype: "CalleeOutputPartiallyRead",
                    family: "intercontract",
                    solidity: `${SOL}/external_call_return_struct.sol`,
                    stresses: "a wide callee output of which one member is used",
                    axis: "partial output read",
                },
                state: "uint64 valueOnly;\nuint64 presentCount;\nuint64 populationSum;\nuint64 reads;",
                entries: [
                    {
                        name: "Seed",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nuint64 value;",
                        locals: "WideLedger::Put_input request;\nWideLedger::Put_output reply;",
                        body: `
                            locals.request.key = input.key;
                            locals.request.value = input.value;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(WideLedger, Put, locals.request, locals.reply, 0);
                        `,
                    },
                    {
                        name: "ReadOne",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 key;",
                        locals: "WideLedger::Get_input query;\nWideLedger::Get_output answer;",
                        body: `
                            locals.query.key = input.key;
                            CALL_OTHER_CONTRACT_FUNCTION(WideLedger, Get, locals.query, locals.answer);
                            // Only the value member is used here; present and population still crossed the call.
                            state.mut().valueOnly = locals.answer.value;
                            state.mut().presentCount += locals.answer.present;
                            state.mut().populationSum += locals.answer.population;
                            state.mut().reads++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 valueOnly;\nuint64 presentCount;\nuint64 populationSum;\nuint64 reads;",
                        body: `
                            output.valueOnly = state.get().valueOnly;
                            output.presentCount = state.get().presentCount;
                            output.populationSum = state.get().populationSum;
                            output.reads = state.get().reads;
                        `,
                    },
                ],
                initialize: "state.mut().valueOnly = 0;\nstate.mut().presentCount = 0;\nstate.mut().populationSum = 0;\nstate.mut().reads = 0;",
            });
            const steps: CallStep[] = [];
            for (const [key, value] of [
                [1n, 11n],
                [2n, 22n],
                [3n, 33n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(key) + u64(value), invocator: 0 });
                steps.push({ kind: "procedure", entry: 2, in: u64(key), invocator: 0 });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "procedure", entry: 2, in: u64(99), invocator: 0, note: "a key the callee never saw" });
            steps.push({ kind: "function", entry: 1 });
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps), callee };
        },
    },

    {
        name: "CalleeRewardLadder",
        family: "intercontract",
        solidity: `${SOL}/external_call_value.sol`,
        stresses:
            "the invocation reward passed across the boundary at four amounts, including zero and more than the caller was given — the callee records what it actually received",
        caveat: "Solidity's `call{value:}` reverts when the balance is short; QPI's invocation carries the amount and the callee sees what arrived.",
        axes: ["placement"],
        build(axis) {
            const callee = tableCallee("RewardLedger", axis);
            const source = emitContract({
                axis,
                name: "CalleeRewardLadder",
                header: {
                    archetype: "CalleeRewardLadder",
                    family: "intercontract",
                    solidity: `${SOL}/external_call_value.sol`,
                    stresses: "invocation rewards attached to a cross-contract call",
                    caveat: "a short balance is not a revert here",
                    axis: "reward ladder",
                },
                state: "sint64 receivedByCaller;\nsint64 forwarded;\nuint64 calls;\nsint64 lastSlot;",
                entries: [
                    {
                        name: "Forward",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nsint64 forwardAmount;",
                        locals: "RewardLedger::Put_input request;\nRewardLedger::Put_output reply;",
                        body: `
                            state.mut().receivedByCaller += qpi.invocationReward();
                            locals.request.key = input.key;
                            locals.request.value = (uint64)input.forwardAmount;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(RewardLedger, Put, locals.request, locals.reply, input.forwardAmount);
                            state.mut().forwarded += input.forwardAmount;
                            state.mut().lastSlot = locals.reply.slot;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 receivedByCaller;\nsint64 forwarded;\nuint64 calls;\nsint64 lastSlot;",
                        body: `
                            output.receivedByCaller = state.get().receivedByCaller;
                            output.forwarded = state.get().forwarded;
                            output.calls = state.get().calls;
                            output.lastSlot = state.get().lastSlot;
                        `,
                    },
                ],
                initialize: "state.mut().receivedByCaller = 0;\nstate.mut().forwarded = 0;\nstate.mut().calls = 0;\nstate.mut().lastSlot = 0;",
            });
            const steps: CallStep[] = [];
            for (const [key, forward, reward] of [
                [1n, 0n, "0"],
                [2n, 10n, "100"],
                [3n, 100n, "10"],
                [4n, 1000000n, "0"],
            ] as [bigint, bigint, string][]) {
                steps.push({
                    kind: "procedure",
                    entry: 1,
                    in: u64(key) + u64(forward),
                    invocator: 0,
                    amount: reward,
                    note: `forward ${forward} with reward ${reward}`,
                });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps), callee };
        },
    },
];
