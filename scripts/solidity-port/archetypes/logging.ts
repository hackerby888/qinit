// Events and logs.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

// A QPI log payload: the leading word is a contract index the host overwrites, the trailing sint8 is the
// terminator. Both are placement questions, so the archetypes below vary where the terminator sits.
const LOG_MSG_TERMINATOR_LAST = `
struct LogMsg
{
    uint32 _contractIndex;
    uint32 _type;
    uint64 value;
    sint8 _terminator;
};`;

const LOG_MSG_TERMINATOR_FIRST = `
struct LogMsg
{
    uint32 _contractIndex;
    uint32 _type;
    sint8 _terminator;
    uint64 value;
};`;

const LOG_MSG_NESTED = `
struct Pair
{
    uint64 left;
    uint32 right;
};

struct LogMsg
{
    uint32 _contractIndex;
    uint32 _type;
    id who;
    Pair pair;
    sint8 _terminator;
};`;

function emitSteps(counts: bigint[]): CallStep[] {
    const steps: CallStep[] = [];
    for (const count of counts) {
        steps.push({ kind: "procedure", entry: 1, in: u64(count), invocator: 0, note: `${count} log(s)` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const LOGGING_ARCHETYPES: Archetype[] = [
    {
        name: "LogTerminatorLast",
        family: "logging",
        solidity: `${SOL}/events/event_emit.sol`,
        stresses: "the canonical log payload: contract index word, type word, fields, terminator last",
        caveat: "Solidity events are indexed and ABI-encoded; a QPI log is a raw struct with a fixed header and terminator.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogTerminatorLast",
                header: {
                    archetype: "LogTerminatorLast",
                    family: "logging",
                    solidity: `${SOL}/events/event_emit.sol`,
                    stresses: "canonical LOG_INFO payload layout",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                prelude: "enum LogKind { Started = 0, Value = 1, Done = 2 };",
                state: "uint64 emitted;",
                statePlacement: axis.placement,
                extraStructs: LOG_MSG_TERMINATOR_LAST,
                entries: [
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "LogMsg message;\nuint64 i;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._type = Value;
                            locals.message._terminator = 0;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.message.value = locals.i;
                                LOG_INFO(locals.message);
                                state.mut().emitted++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 emitted;",
                        body: "output.emitted = state.get().emitted;",
                    },
                ],
                initialize: "state.mut().emitted = 0;",
            });
            return { source, script: script(emitSteps([0n, 1n, 3n])) };
        },
    },

    {
        name: "LogTerminatorFirst",
        family: "logging",
        solidity: `${SOL}/events/event_emit.sol`,
        stresses: "the terminator declared before the payload fields rather than after — both compilers must refuse it, by independent mechanisms",
        caveat: "Agreement-on-rejection row. The TypeScript backend refuses it through its build gate; clang refuses it through core's own static_assert in lhost_imports.h, so the two verdicts are independently derived.",
        axes: [],
        expectReject: true,
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogTerminatorFirst",
                header: {
                    archetype: "LogTerminatorFirst",
                    family: "logging",
                    solidity: `${SOL}/events/event_emit.sol`,
                    stresses: "terminator placed before the payload fields",
                    caveat: "A deliberately non-canonical layout; the two backends must still produce identical log bytes.",
                    axis: "base",
                },
                state: "uint64 emitted;",
                extraStructs: LOG_MSG_TERMINATOR_FIRST,
                entries: [
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "LogMsg message;\nuint64 i;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._type = 5;
                            locals.message._terminator = 0;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.message.value = locals.i + 100;
                                LOG_INFO(locals.message);
                                state.mut().emitted++;
                            }
                        `,
                    },
                    { name: "Read", kind: "function", number: 1, output: "uint64 emitted;", body: "output.emitted = state.get().emitted;" },
                ],
                initialize: "state.mut().emitted = 0;",
            });
            return { source, script: script(emitSteps([1n, 2n])) };
        },
    },

    {
        name: "LogSeverityLadder",
        family: "logging",
        solidity: `${SOL}/events/event_lots_of_data.sol`,
        stresses: "ERROR, WARNING, INFO and DEBUG emitted from one procedure, with a paused region in the middle",
        caveat: "LOG_PAUSE has no Solidity analogue; it is included because the repo has an open finding about pause being honoured by core and ignored by the debug trace.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogSeverityLadder",
                header: {
                    archetype: "LogSeverityLadder",
                    family: "logging",
                    solidity: `${SOL}/events/event_lots_of_data.sol`,
                    stresses: "all four log severities plus LOG_PAUSE / LOG_RESUME",
                    axis: "base",
                },
                state: "uint64 emitted;\nuint64 paused;",
                extraStructs: LOG_MSG_TERMINATOR_LAST,
                entries: [
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "LogMsg message;\nuint64 i;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._terminator = 0;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.message.value = locals.i;
                                locals.message._type = 1;
                                LOG_INFO(locals.message);
                                locals.message._type = 2;
                                LOG_WARNING(locals.message);
                                locals.message._type = 3;
                                LOG_DEBUG(locals.message);
                                state.mut().emitted += 3;
                                LOG_PAUSE();
                                locals.message._type = 4;
                                LOG_ERROR(locals.message);
                                state.mut().paused++;
                                LOG_RESUME();
                                locals.message._type = 5;
                                LOG_ERROR(locals.message);
                                state.mut().emitted++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 emitted;\nuint64 paused;",
                        body: "output.emitted = state.get().emitted;\noutput.paused = state.get().paused;",
                    },
                ],
                initialize: "state.mut().emitted = 0;\nstate.mut().paused = 0;",
            });
            return { source, script: script(emitSteps([1n, 2n])) };
        },
    },

    {
        name: "LogNestedStructPayload",
        family: "logging",
        solidity: `${SOL}/events/event_struct_memory_v2.sol`,
        stresses: "a log payload carrying a nested struct and an id — padding inside the payload is part of the emitted bytes",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogNestedStructPayload",
                header: {
                    archetype: "LogNestedStructPayload",
                    family: "logging",
                    solidity: `${SOL}/events/event_struct_memory_v2.sol`,
                    stresses: "nested struct and id inside a log payload",
                    axis: "base",
                },
                state: "uint64 emitted;",
                extraStructs: LOG_MSG_NESTED,
                entries: [
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "LogMsg message;\nuint64 i;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._type = 9;
                            locals.message._terminator = 0;
                            locals.message.who = qpi.invocator();
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.message.pair.left = locals.i;
                                locals.message.pair.right = (uint32)(locals.i + 1);
                                LOG_INFO(locals.message);
                                state.mut().emitted++;
                            }
                        `,
                    },
                    { name: "Read", kind: "function", number: 1, output: "uint64 emitted;", body: "output.emitted = state.get().emitted;" },
                ],
                initialize: "state.mut().emitted = 0;",
            });
            return { source, script: script(emitSteps([1n, 2n, 0n])) };
        },
    },
];
