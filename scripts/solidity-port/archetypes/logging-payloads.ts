// The second logging batch: payload layout, type identity and where a log may be emitted from.
//
// Ported from Solidity's `events/*`. The logs themselves are not part of the contract's state, so a log
// difference does not move the K12 digest — the harness records every step's logs separately and
// compares them, which makes this family the cheapest signal in the corpus: a payload laid out
// differently by the two backends shows up as a step-level log mismatch long before any state does.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/events";

function emitSteps(counts: bigint[]): CallStep[] {
    const steps: CallStep[] = [];
    for (const count of counts) {
        steps.push({ kind: "procedure", entry: 1, in: u64(count), invocator: 0, note: `${count} log(s)` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const LOGGING_PAYLOAD_ARCHETYPES: Archetype[] = [
    {
        name: "LogMixedWidthFieldOrder",
        family: "logging",
        solidity: `${SOL}/event_various_types.sol`,
        stresses: "a payload whose fields are declared narrow-to-wide, so the struct carries interior padding the two backends must place identically",
        caveat: "Solidity ABI-encodes each event argument to 32 bytes; a QPI log payload is the raw struct, so the padding is real and observable.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogMixedWidthFieldOrder",
                header: {
                    archetype: "LogMixedWidthFieldOrder",
                    family: "logging",
                    solidity: `${SOL}/event_various_types.sol`,
                    stresses: "interior padding inside a log payload",
                    caveat: "no ABI encoding — the payload is the struct",
                    axis: "mixed-width payload",
                },
                prelude: "enum LogKind { Started = 0, Value = 1, Done = 2 };",
                extraStructs: `
                    struct LogMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        uint8 flag;
                        uint64 wide;
                        uint16 medium;
                        uint8 tail;
                        sint8 _terminator;
                    };
                `,
                state: "uint64 emitted;\nuint64 lastWide;",
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
                                locals.message.flag = (uint8)locals.i;
                                locals.message.wide = locals.i * 1000000007ULL;
                                locals.message.medium = (uint16)(locals.i * 257);
                                locals.message.tail = (uint8)(255 - locals.i);
                                LOG_INFO(locals.message);
                                state.mut().emitted++;
                                state.mut().lastWide = locals.message.wide;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 emitted;\nuint64 lastWide;",
                        body: "output.emitted = state.get().emitted;\noutput.lastWide = state.get().lastWide;",
                    },
                ],
                initialize: "state.mut().emitted = 0;\nstate.mut().lastWide = 0;",
            });
            return { source, script: script(emitSteps([0n, 1n, 3n])) };
        },
    },

    {
        name: "LogTwinTypesSameFieldNames",
        family: "logging",
        solidity: `${SOL}/event_anonymous_with_signature_collision.sol`,
        stresses: "two log payload types with the same field names but different widths, emitted from one procedure — the type word has to distinguish them",
        caveat: "Solidity distinguishes events by the hash of their signature; QPI distinguishes them by a type word the contract sets, so the port sets it explicitly.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogTwinTypesSameFieldNames",
                header: {
                    archetype: "LogTwinTypesSameFieldNames",
                    family: "logging",
                    solidity: `${SOL}/event_anonymous_with_signature_collision.sol`,
                    stresses: "two payload types that differ only in field width",
                    caveat: "the type word replaces the signature hash",
                    axis: "twin payload types",
                },
                prelude: "enum LogKind { Narrow = 7, Wide = 8 };",
                extraStructs: `
                    struct NarrowMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        uint16 amount;
                        uint16 tag;
                        sint8 _terminator;
                    };

                    struct WideMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        uint64 amount;
                        uint64 tag;
                        sint8 _terminator;
                    };
                `,
                state: "uint64 narrowEmitted;\nuint64 wideEmitted;",
                entries: [
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "NarrowMsg narrow;\nWideMsg wide;\nuint64 i;",
                        body: `
                            locals.narrow._contractIndex = 0;
                            locals.narrow._type = Narrow;
                            locals.narrow._terminator = 0;
                            locals.wide._contractIndex = 0;
                            locals.wide._type = Wide;
                            locals.wide._terminator = 0;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.narrow.amount = (uint16)(locals.i * 1000);
                                locals.narrow.tag = (uint16)locals.i;
                                LOG_INFO(locals.narrow);
                                state.mut().narrowEmitted++;
                                locals.wide.amount = locals.i * 1000;
                                locals.wide.tag = locals.i;
                                LOG_INFO(locals.wide);
                                state.mut().wideEmitted++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 narrowEmitted;\nuint64 wideEmitted;",
                        body: "output.narrowEmitted = state.get().narrowEmitted;\noutput.wideEmitted = state.get().wideEmitted;",
                    },
                ],
                initialize: "state.mut().narrowEmitted = 0;\nstate.mut().wideEmitted = 0;",
            });
            return { source, script: script(emitSteps([0n, 1n, 4n])) };
        },
    },

    {
        name: "LogFromPrivateProcedure",
        family: "logging",
        solidity: `${SOL}/event_emit_from_other_contract.sol`,
        stresses: "a log emitted from a private procedure reached by CALL rather than from the public entry — the emitting frame is not the entry frame",
        caveat: "The Solidity original emits from another contract; QPI's cross-contract logs belong to the callee, so the nearest same-contract shape is a private procedure.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogFromPrivateProcedure",
                header: {
                    archetype: "LogFromPrivateProcedure",
                    family: "logging",
                    solidity: `${SOL}/event_emit_from_other_contract.sol`,
                    stresses: "LOG_INFO from inside a private procedure",
                    caveat: "emitting from another contract becomes emitting from a private procedure",
                    axis: "log from a nested frame",
                },
                prelude: "enum LogKind { InnerEmit = 3 };",
                extraStructs: `
                    struct LogMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        uint64 value;
                        sint8 _terminator;
                    };
                `,
                state: "uint64 emitted;\nuint64 depth;",
                entries: [
                    {
                        name: "Inner",
                        kind: "procedure",
                        visibility: "private",
                        number: 0,
                        input: "uint64 value;",
                        output: "uint64 echoed;",
                        locals: "LogMsg message;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._type = InnerEmit;
                            locals.message._terminator = 0;
                            locals.message.value = input.value;
                            LOG_INFO(locals.message);
                            state.mut().emitted++;
                            output.echoed = input.value + 1;
                        `,
                    },
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "Inner_input request;\nInner_output response;\nuint64 i;",
                        body: `
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.request.value = locals.i;
                                CALL(Inner, locals.request, locals.response);
                                state.mut().depth = locals.response.echoed;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 emitted;\nuint64 depth;",
                        body: "output.emitted = state.get().emitted;\noutput.depth = state.get().depth;",
                    },
                ],
                initialize: "state.mut().emitted = 0;\nstate.mut().depth = 0;",
            });
            return { source, script: script(emitSteps([0n, 1n, 3n])) };
        },
    },

    {
        name: "LogInsideConditionalBranch",
        family: "logging",
        solidity: `${SOL}/event_emit_in_branch.sol`,
        stresses: "logs emitted from both arms of a branch inside a loop, so the emitted sequence — not just the count — encodes the path taken",
        axes: ["placement", "loopShape"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogInsideConditionalBranch",
                header: {
                    archetype: "LogInsideConditionalBranch",
                    family: "logging",
                    solidity: `${SOL}/event_emit_in_branch.sol`,
                    stresses: "the log sequence as a record of the path taken",
                    axis: "branch-dependent logs",
                },
                prelude: "enum LogKind { Even = 10, Odd = 11 };",
                extraStructs: `
                    struct LogMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        uint64 index;
                        uint64 value;
                        sint8 _terminator;
                    };
                `,
                state: "uint64 evens;\nuint64 odds;",
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
                                locals.message.index = locals.i;
                                if (QPI::mod(locals.i, 2ULL) == 0)
                                {
                                    locals.message._type = Even;
                                    locals.message.value = locals.i * 2;
                                    LOG_INFO(locals.message);
                                    state.mut().evens++;
                                }
                                else
                                {
                                    locals.message._type = Odd;
                                    locals.message.value = locals.i * 3;
                                    LOG_INFO(locals.message);
                                    state.mut().odds++;
                                }
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 evens;\nuint64 odds;",
                        body: "output.evens = state.get().evens;\noutput.odds = state.get().odds;",
                    },
                ],
                initialize: "state.mut().evens = 0;\nstate.mut().odds = 0;",
            });
            return { source, script: script(emitSteps([0n, 1n, 2n, 5n])) };
        },
    },

    {
        name: "LogPayloadWithArrayField",
        family: "logging",
        solidity: `${SOL}/event_dynamic_array_memory.sol`,
        stresses: "a fixed Array inside a log payload — a member whose size is the product of its element size and capacity, and which is emitted whole",
        caveat: "Solidity encodes a dynamic array as an offset plus length plus elements; QPI has no dynamic arrays, so the port emits a fixed one and the whole struct goes into the log.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = 4;
            const source = emitContract({
                axis,
                name: "LogPayloadWithArrayField",
                header: {
                    archetype: "LogPayloadWithArrayField",
                    family: "logging",
                    solidity: `${SOL}/event_dynamic_array_memory.sol`,
                    stresses: "an Array member inside a log payload",
                    caveat: "dynamic arrays become fixed ones",
                    axis: `array capacity=${capacity}`,
                },
                prelude: "enum LogKind { Batch = 5 };",
                extraStructs: `
                    struct LogMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        Array<uint32, ${capacity}> values;
                        uint64 total;
                        sint8 _terminator;
                    };
                `,
                state: "uint64 emitted;\nuint64 lastTotal;",
                entries: [
                    {
                        name: "Emit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "LogMsg message;\nuint64 i;\nuint64 j;\nuint64 total;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._type = Batch;
                            locals.message._terminator = 0;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.total = 0;
                                for (locals.j = 0; locals.j < ${capacity}; locals.j++)
                                {
                                    locals.message.values.set(locals.j, (uint32)(locals.i * 16 + locals.j));
                                    locals.total += locals.i * 16 + locals.j;
                                }
                                locals.message.total = locals.total;
                                LOG_INFO(locals.message);
                                state.mut().emitted++;
                                state.mut().lastTotal = locals.total;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 emitted;\nuint64 lastTotal;",
                        body: "output.emitted = state.get().emitted;\noutput.lastTotal = state.get().lastTotal;",
                    },
                ],
                initialize: "state.mut().emitted = 0;\nstate.mut().lastTotal = 0;",
            });
            return { source, script: script(emitSteps([0n, 1n, 3n])) };
        },
    },

    {
        name: "LogAndStateWriteInterleaved",
        family: "logging",
        solidity: `${SOL}/event_emit_and_state_change.sol`,
        stresses: "a log between two writes to the same member, so the emitted value pins which write had happened when the log was taken",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "LogAndStateWriteInterleaved",
                header: {
                    archetype: "LogAndStateWriteInterleaved",
                    family: "logging",
                    solidity: `${SOL}/event_emit_and_state_change.sol`,
                    stresses: "the ordering of a log against the writes around it",
                    axis: "log between writes",
                },
                prelude: "enum LogKind { Before = 20, After = 21 };",
                extraStructs: `
                    struct LogMsg
                    {
                        uint32 _contractIndex;
                        uint32 _type;
                        uint64 observed;
                        sint8 _terminator;
                    };
                `,
                state: "uint64 counter;\nuint64 emitted;",
                entries: [
                    {
                        name: "Step",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 delta;",
                        locals: "LogMsg message;",
                        body: `
                            locals.message._contractIndex = 0;
                            locals.message._terminator = 0;
                            state.mut().counter += input.delta;
                            locals.message._type = Before;
                            locals.message.observed = state.get().counter;
                            LOG_INFO(locals.message);
                            state.mut().counter *= 2;
                            locals.message._type = After;
                            locals.message.observed = state.get().counter;
                            LOG_INFO(locals.message);
                            state.mut().emitted += 2;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 counter;\nuint64 emitted;",
                        body: "output.counter = state.get().counter;\noutput.emitted = state.get().emitted;",
                    },
                ],
                initialize: "state.mut().counter = 0;\nstate.mut().emitted = 0;",
            });
            return { source, script: script(emitSteps([1n, 2n, 0n, 7n])) };
        },
    },
];
