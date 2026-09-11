// Logs whose payload is computed rather than copied: counters, digests, packed fields and the log a loop emits once per iteration with a running value.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

const SOL = "test/libsolidity/semanticTests/events";

const SIMPLE_LOG = `
struct LogMsg
{
    uint32 _contractIndex;
    uint32 _type;
    uint64 value;
    sint8 _terminator;
};`;

export const LOGGING_MORE_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "LogValueDerivedFromArithmetic",
            family: "logging",
            solidity: `${SOL}/event_emit.sol`,
            stresses: "a payload field computed by the same arithmetic that writes state, so the log and the state must agree on the value",
        },
        () => ({
            extraStructs: SIMPLE_LOG,
            prelude: "enum LogKind { Computed = 70 };",
            state: "uint64 stored;\nuint64 emitted;",
            locals: "LogMsg message;\nuint64 value;",
            body: `
                locals.value = input.a * 3 + input.b;
                state.mut().stored = locals.value;
                locals.message._contractIndex = 0;
                locals.message._type = Computed;
                locals.message._terminator = 0;
                locals.message.value = locals.value;
                LOG_INFO(locals.message);
                state.mut().emitted++;
            `,
            pairs: [
                [0n, 0n],
                [1n, 2n],
                [18446744073709551615n, 1n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "LogCountMatchesLoopTrips",
            family: "logging",
            solidity: `${SOL}/event_emit.sol`,
            stresses:
                "one log per loop iteration with the index in the payload — the log count is the trip count, so an unrolled loop that emits once too often is visible without touching state",
        },
        () => ({
            extraStructs: SIMPLE_LOG,
            prelude: "enum LogKind { Iteration = 71 };",
            state: "uint64 trips;\nuint64 sum;",
            locals: "LogMsg message;\nuint64 i;\nuint64 bounded;",
            body: `
                locals.bounded = input.a > 8 ? 8 : input.a;
                locals.message._contractIndex = 0;
                locals.message._type = Iteration;
                locals.message._terminator = 0;
                for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                {
                    locals.message.value = locals.i;
                    LOG_INFO(locals.message);
                    state.mut().sum += locals.i;
                }
                state.mut().trips = locals.bounded;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [8n, 0n],
                [100n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n], note: "no iterations, no logs" },
                { pair: 1, values: [1n, 0n], note: "one iteration adds index zero" },
                { pair: 2, values: [8n, 28n], note: "eight iterations sum 0..7" },
                { pair: 3, values: [8n, 56n], note: "clamped to eight again" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "LogDigestPayload",
            family: "logging",
            solidity: `${SOL}/event_indexed_address.sol`,
            stresses:
                "a K12 digest carried in a log payload — 32 bytes of computed data crossing into the log buffer, next to the same digest's first word stored in state",
        },
        () => ({
            extraStructs: "struct LogMsg\n{\n    uint32 _contractIndex;\n    uint32 _type;\n    id digest;\n    uint64 seed;\n    sint8 _terminator;\n};",
            prelude: "enum LogKind { Digest = 72 };",
            state: "uint64 firstWord;\nuint64 emitted;",
            locals: "LogMsg message;\nid digest;\nuint64 seed;",
            body: `
                locals.seed = input.a;
                locals.digest = qpi.K12(locals.seed);
                locals.message._contractIndex = 0;
                locals.message._type = Digest;
                locals.message._terminator = 0;
                locals.message.digest = locals.digest;
                locals.message.seed = locals.seed;
                LOG_INFO(locals.message);
                state.mut().firstWord = locals.digest.u64._0;
                state.mut().emitted++;
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [18446744073709551615n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "LogPackedBitFields",
            family: "logging",
            solidity: `${SOL}/event_various_types.sol`,
            stresses:
                "a payload whose fields are packed by hand into one uint64 and also carried as separate narrow members — the same information twice, so a padding difference between them shows up",
        },
        () => ({
            extraStructs:
                "struct LogMsg\n{\n    uint32 _contractIndex;\n    uint32 _type;\n    uint64 packed;\n    uint8 flag;\n    uint16 medium;\n    uint32 wide;\n    sint8 _terminator;\n};",
            prelude: "enum LogKind { Packed = 73 };",
            state: "uint64 packed;\nuint64 emitted;",
            locals: "LogMsg message;\nuint64 value;",
            body: `
                locals.value = ((input.a & 255ULL) << 48) | ((input.b & 65535ULL) << 32) | (input.a & 4294967295ULL);
                locals.message._contractIndex = 0;
                locals.message._type = Packed;
                locals.message._terminator = 0;
                locals.message.packed = locals.value;
                locals.message.flag = (uint8)input.a;
                locals.message.medium = (uint16)input.b;
                locals.message.wide = (uint32)input.a;
                LOG_INFO(locals.message);
                state.mut().packed = locals.value;
                state.mut().emitted++;
            `,
            pairs: [
                [0n, 0n],
                [255n, 65535n],
                [18446744073709551615n, 18446744073709551615n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "LogTwoTypesAlternating",
            family: "logging",
            solidity: `${SOL}/event_anonymous_with_signature_collision.sol`,
            stresses:
                "two payload types emitted alternately from one loop, so the log sequence interleaves them — a step's log list is ordered, and the order is part of what is compared",
        },
        () => ({
            extraStructs:
                "struct AlphaMsg\n{\n    uint32 _contractIndex;\n    uint32 _type;\n    uint64 value;\n    sint8 _terminator;\n};\n\nstruct BetaMsg\n{\n    uint32 _contractIndex;\n    uint32 _type;\n    uint32 small;\n    uint32 other;\n    sint8 _terminator;\n};",
            prelude: "enum LogKind { Alpha = 74, Beta = 75 };",
            state: "uint64 alphaCount;\nuint64 betaCount;",
            locals: "AlphaMsg alpha;\nBetaMsg beta;\nuint64 i;\nuint64 bounded;",
            body: `
                locals.alpha._contractIndex = 0;
                locals.alpha._type = Alpha;
                locals.alpha._terminator = 0;
                locals.beta._contractIndex = 0;
                locals.beta._type = Beta;
                locals.beta._terminator = 0;
                locals.bounded = input.a > 6 ? 6 : input.a;
                for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                {
                    if (QPI::mod(locals.i, 2ULL) == 0)
                    {
                        locals.alpha.value = locals.i;
                        LOG_INFO(locals.alpha);
                        state.mut().alphaCount++;
                    }
                    else
                    {
                        locals.beta.small = (uint32)locals.i;
                        locals.beta.other = (uint32)(locals.i * 2);
                        LOG_INFO(locals.beta);
                        state.mut().betaCount++;
                    }
                }
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [5n, 0n],
                [6n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 0n], note: "no logs" },
                { pair: 1, values: [1n, 0n], note: "one alpha" },
                { pair: 2, values: [4n, 2n], note: "three alphas and two betas, on top of the earlier one" },
                { pair: 3, values: [7n, 5n], note: "three more alphas and three more betas" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "LogAfterStateWriteOrdering",
            family: "logging",
            solidity: `${SOL}/event_emit_and_state_change.sol`,
            stresses:
                "three writes with a log after each, so the log sequence is a trace of the state's intermediate values — a reordered store shows up in the logs before the final digest could reveal it",
        },
        () => ({
            extraStructs: SIMPLE_LOG,
            prelude: "enum LogKind { Trace = 76 };",
            state: "uint64 counter;\nuint64 logs;",
            locals: "LogMsg message;",
            body: `
                locals.message._contractIndex = 0;
                locals.message._type = Trace;
                locals.message._terminator = 0;
                state.mut().counter += input.a;
                locals.message.value = state.get().counter;
                LOG_INFO(locals.message);
                state.mut().counter *= 2;
                locals.message.value = state.get().counter;
                LOG_INFO(locals.message);
                state.mut().counter -= input.b;
                locals.message.value = state.get().counter;
                LOG_INFO(locals.message);
                state.mut().logs += 3;
            `,
            pairs: [
                [1n, 0n],
                [5n, 3n],
                [0n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "LogFromBothBranches",
            family: "logging",
            solidity: `${SOL}/event_emit_in_branch.sol`,
            stresses:
                "a log in each arm of a branch with a different type word, so the emitted type says which arm ran even though both arms write the same member",
        },
        () => ({
            extraStructs: SIMPLE_LOG,
            prelude: "enum LogKind { Low = 77, High = 78 };",
            state: "uint64 lows;\nuint64 highs;\nuint64 lastValue;",
            locals: "LogMsg message;",
            body: `
                locals.message._contractIndex = 0;
                locals.message._terminator = 0;
                locals.message.value = input.a;
                if (input.a < 100)
                {
                    locals.message._type = Low;
                    LOG_INFO(locals.message);
                    state.mut().lows++;
                }
                else
                {
                    locals.message._type = High;
                    LOG_INFO(locals.message);
                    state.mut().highs++;
                }
                state.mut().lastValue = input.a;
            `,
            pairs: [
                [0n, 0n],
                [99n, 0n],
                [100n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [1n, 0n, 0n], note: "the low arm" },
                { pair: 2, values: [2n, 1n, 100n], note: "the high arm, with two lows behind it" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "LogSuppressedByGuard",
            family: "logging",
            solidity: `${SOL}/event_emit_in_branch.sol`,
            stresses:
                "a guard that returns before the log, so a call that fails its check emits nothing at all — the absence of a log is the signal, and it has to be the same absence on both backends",
        },
        () => ({
            extraStructs: SIMPLE_LOG,
            prelude: "enum LogKind { Accepted = 79 };",
            state: "uint64 accepted;\nuint64 rejected;\nuint64 emitted;",
            locals: "LogMsg message;",
            body: `
                if (input.a == 0 || input.a > 1000)
                {
                    state.mut().rejected++;
                }
                else
                {
                    locals.message._contractIndex = 0;
                    locals.message._type = Accepted;
                    locals.message._terminator = 0;
                    locals.message.value = input.a;
                    LOG_INFO(locals.message);
                    state.mut().accepted++;
                    state.mut().emitted++;
                }
            `,
            pairs: [
                [0n, 0n],
                [500n, 0n],
                [1001n, 0n],
                [1000n, 0n],
            ],
            expect: [
                { pair: 0, values: [0n, 1n, 0n], note: "zero is refused before the log" },
                { pair: 1, values: [1n, 1n, 1n], note: "an accepted call emits one" },
                { pair: 2, values: [1n, 2n, 1n], note: "past the ceiling, refused" },
                { pair: 3, values: [2n, 2n, 2n], note: "exactly on the ceiling, accepted" },
            ],
        }),
    ),
];
