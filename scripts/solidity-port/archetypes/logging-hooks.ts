// Logs emitted from where a Solidity contract cannot emit them.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/events";

const LOG_MSG = `
struct LogMsg
{
    uint32 _contractIndex;
    uint32 _type;
    uint64 value;
    sint8 _terminator;
};`;

export const LOGGING_HOOK_ARCHETYPES: Archetype[] = [
    {
        name: "LogFromTickHooks",
        family: "logging",
        solidity: `${SOL}/event_emit.sol`,
        stresses:
            "LOG_INFO from BEGIN_TICK and END_TICK — two logs per tick with no transaction on the stack, so the emitted sequence is driven entirely by tick advancement",
        caveat: "Solidity cannot emit outside a transaction at all, so the hook half has no original.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogFromTickHooks",
                header: {
                    archetype: "LogFromTickHooks",
                    family: "logging",
                    solidity: `${SOL}/event_emit.sol`,
                    stresses: "logs emitted from the tick hooks",
                    caveat: "no out-of-transaction events in Solidity",
                    axis: "hook logs",
                },
                prelude: "enum LogKind { TickBegan = 30, TickEnded = 31, UserCalled = 32 };",
                extraStructs: LOG_MSG,
                state: "uint64 beginLogs;\nuint64 endLogs;\nuint64 userLogs;",
                entries: [
                    {
                        name: "Touch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "LogMsg message;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._type = UserCalled;
                            locals.message._terminator = 0;
                            locals.message.value = input.value;
                            LOG_INFO(locals.message);
                            state.mut().userLogs++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 beginLogs;\nuint64 endLogs;\nuint64 userLogs;",
                        body: "output.beginLogs = state.get().beginLogs;\noutput.endLogs = state.get().endLogs;\noutput.userLogs = state.get().userLogs;",
                    },
                ],
                initialize: "state.mut().beginLogs = 0;\nstate.mut().endLogs = 0;\nstate.mut().userLogs = 0;",
                beginTick: `
                    state.mut().beginLogs++;
                `,
                endTick: `
                    state.mut().endLogs++;
                `,
            });
            const steps: CallStep[] = [
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 1 },
                { kind: "procedure", entry: 1, in: u64(7), invocator: 0 },
                { kind: "function", entry: 1 },
                { kind: "advanceTick", n: 2 },
                { kind: "function", entry: 1 },
            ];
            return { source, script: script(steps) };
        },
    },

    {
        name: "LogPayloadWithIdField",
        family: "logging",
        solidity: `${SOL}/event_indexed_address.sol`,
        stresses:
            "a 32-byte id inside a log payload, written from the invocator and from a K12 — the widest member a payload can carry and the one whose alignment moves the terminator",
        caveat: "Solidity would index the address into a topic; a QPI payload carries it inline, so the bytes are part of the message rather than of a filter.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogPayloadWithIdField",
                header: {
                    archetype: "LogPayloadWithIdField",
                    family: "logging",
                    solidity: `${SOL}/event_indexed_address.sol`,
                    stresses: "an id member inside a log payload",
                    caveat: "no indexed topics — the id is inline",
                    axis: "id in payload",
                },
                prelude: "enum LogKind { Transfer = 40 };",
                extraStructs: `
                    struct LogMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        id from;
                        id to;
                        uint64 amount;
                        sint8 _terminator;
                    };
                `,
                state: "uint64 emitted;\nuint64 lastAmount;",
                entries: [
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "LogMsg message;\nuint64 i;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._type = Transfer;
                            locals.message._terminator = 0;
                            locals.message.from = qpi.invocator();
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.message.to = qpi.K12(locals.i);
                                locals.message.amount = locals.i * 1000;
                                LOG_INFO(locals.message);
                                state.mut().emitted++;
                                state.mut().lastAmount = locals.message.amount;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 emitted;\nuint64 lastAmount;",
                        body: "output.emitted = state.get().emitted;\noutput.lastAmount = state.get().lastAmount;",
                    },
                ],
                initialize: "state.mut().emitted = 0;\nstate.mut().lastAmount = 0;",
            });
            const steps: CallStep[] = [];
            for (const count of [0n, 1n, 3n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(count), invocator: 0, note: `${count} log(s)` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "LogSkippedByEarlyReturn",
        family: "logging",
        solidity: `${SOL}/event_emit_in_branch.sol`,
        stresses:
            "a log that only happens when an early return does not fire — the emitted count is the record of which path ran, and it must match the state the same call left behind",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogSkippedByEarlyReturn",
                header: {
                    archetype: "LogSkippedByEarlyReturn",
                    family: "logging",
                    solidity: `${SOL}/event_emit_in_branch.sol`,
                    stresses: "a log on the far side of an early return",
                    axis: "skipped log",
                },
                prelude: "enum LogKind { Accepted = 50, Rejected = 51 };",
                extraStructs: LOG_MSG,
                state: "uint64 accepted;\nuint64 rejected;\nuint64 logged;",
                entries: [
                    {
                        name: "Submit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "LogMsg message;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._terminator = 0;
                            locals.message.value = input.amount;
                            if (input.amount == 0 || input.amount > 1000)
                            {
                                locals.message._type = Rejected;
                                LOG_INFO(locals.message);
                                state.mut().rejected++;
                                state.mut().logged++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().accepted++;
                            locals.message._type = Accepted;
                            LOG_INFO(locals.message);
                            state.mut().logged++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 accepted;\nuint64 rejected;\nuint64 logged;",
                        body: "output.accepted = state.get().accepted;\noutput.rejected = state.get().rejected;\noutput.logged = state.get().logged;",
                    },
                ],
                initialize: "state.mut().accepted = 0;\nstate.mut().rejected = 0;\nstate.mut().logged = 0;",
            });
            const steps: CallStep[] = [];
            for (const amount of [0n, 1n, 1000n, 1001n, 18446744073709551615n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount), invocator: 0, note: `amount ${amount}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "LogFromEpochHook",
        family: "logging",
        solidity: `${SOL}/event_emit.sol`,
        stresses:
            "a settlement log emitted from END_EPOCH, where the payload carries values the hook itself computed — a log whose only trigger is the epoch rolling over",
        caveat: "No Solidity analogue: there is no per-period hook to emit from.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogFromEpochHook",
                header: {
                    archetype: "LogFromEpochHook",
                    family: "logging",
                    solidity: `${SOL}/event_emit.sol`,
                    stresses: "a log emitted by the epoch settlement",
                    caveat: "no per-period hook in Solidity",
                    axis: "epoch log",
                },
                prelude: "enum LogKind { Settled = 60 };",
                extraStructs: LOG_MSG,
                state: "uint64 pending;\nuint64 settled;\nuint64 epochLogs;",
                entries: [
                    {
                        name: "Deposit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        locals: "uint64 scratch;",
                        body: "state.mut().pending += input.amount;",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 pending;\nuint64 settled;\nuint64 epochLogs;",
                        body: "output.pending = state.get().pending;\noutput.settled = state.get().settled;\noutput.epochLogs = state.get().epochLogs;",
                    },
                ],
                initialize: "state.mut().pending = 0;\nstate.mut().settled = 0;\nstate.mut().epochLogs = 0;",
                endEpoch: `
                    state.mut().settled += state.get().pending;
                    state.mut().pending = 0;
                    state.mut().epochLogs++;
                `,
            });
            return {
                source,
                script: script(
                    [
                        { kind: "procedure", entry: 1, in: u64(25), invocator: 0 },
                        { kind: "function", entry: 1 },
                        { kind: "advanceEpoch", n: 1 },
                        { kind: "function", entry: 1 },
                        { kind: "procedure", entry: 1, in: u64(5), invocator: 0 },
                        { kind: "advanceEpoch", n: 1 },
                        { kind: "function", entry: 1 },
                    ],
                    { epochLength: 4 },
                ),
            };
        },
    },
];
