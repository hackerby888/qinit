// Date and time host calls.
//
// Solidity has one clock, `block.timestamp`, and every deadline, vesting schedule and lock in the
// ecosystem is built on comparing it to a stored number. QPI instead exposes the decomposed calendar —
// year, month, day, hour, minute, second, millisecond, plus `dayOfWeek(y, m, d)` and the tick and epoch
// counters — so the port of a deadline pattern has to *recompose* a comparable value out of those
// fields. That recomposition is arithmetic on eight separate host calls, which is exactly the kind of
// code where a width or an ordering difference between two backends shows up.
//
// All of it is deterministic here: the simulator's clock is `timeBaseMs + tick * tickDuration`, and the
// harness pins both the base and the tick before the first step.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64, u8 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

function sampleSteps(ticks: number[]): CallStep[] {
    const steps: CallStep[] = [
        { kind: "procedure", entry: 1, invocator: 0, note: "sample at the pinned tick" },
        { kind: "function", entry: 1 },
    ];
    for (const count of ticks) {
        steps.push({ kind: "advanceTick", n: count });
        steps.push({ kind: "procedure", entry: 1, invocator: 0, note: `sample after +${count} tick(s)` });
        steps.push({ kind: "function", entry: 1 });
    }
    return steps;
}

export const HOSTCALL_TIME_ARCHETYPES: Archetype[] = [
    {
        name: "TimeAllFieldsSampled",
        family: "hostcalls",
        solidity: `${SOL}/various/block_timestamp.sol`,
        stresses:
            "all seven calendar fields read in one procedure and stored at their declared widths — seven host calls whose uint8 and uint16 results are widened on the way into state",
        caveat: "Solidity has a single unix timestamp; QPI has no such value, so the port stores the fields and recomposes a comparable number itself.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimeAllFieldsSampled",
                header: {
                    archetype: "TimeAllFieldsSampled",
                    family: "hostcalls",
                    solidity: `${SOL}/various/block_timestamp.sol`,
                    stresses: "the seven calendar host calls and a recomposed ordinal",
                    caveat: "no unix timestamp in QPI",
                    axis: "calendar fields",
                },
                state: "uint8 year;\nuint8 month;\nuint8 day;\nuint8 hour;\nuint8 minute;\nuint8 second;\nuint16 millisecond;\nuint64 ordinal;\nuint64 samples;",
                entries: [
                    {
                        name: "Sample",
                        kind: "procedure",
                        number: 1,
                        locals: "uint64 packed;",
                        body: `
                            state.mut().year = qpi.year();
                            state.mut().month = qpi.month();
                            state.mut().day = qpi.day();
                            state.mut().hour = qpi.hour();
                            state.mut().minute = qpi.minute();
                            state.mut().second = qpi.second();
                            state.mut().millisecond = qpi.millisecond();
                            // The recomposition every deadline check needs, done in uint64 so nothing wraps.
                            locals.packed = (uint64)qpi.year() * 10000000000ULL;
                            locals.packed += (uint64)qpi.month() * 100000000ULL;
                            locals.packed += (uint64)qpi.day() * 1000000ULL;
                            locals.packed += (uint64)qpi.hour() * 10000ULL;
                            locals.packed += (uint64)qpi.minute() * 100ULL;
                            locals.packed += (uint64)qpi.second();
                            state.mut().ordinal = locals.packed;
                            state.mut().samples++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint8 year;\nuint8 month;\nuint8 day;\nuint8 hour;\nuint8 minute;\nuint8 second;\nuint16 millisecond;\nuint64 ordinal;\nuint64 samples;",
                        body: `
                            output.year = state.get().year;
                            output.month = state.get().month;
                            output.day = state.get().day;
                            output.hour = state.get().hour;
                            output.minute = state.get().minute;
                            output.second = state.get().second;
                            output.millisecond = state.get().millisecond;
                            output.ordinal = state.get().ordinal;
                            output.samples = state.get().samples;
                        `,
                    },
                ],
                initialize:
                    "state.mut().year = 0;\nstate.mut().month = 0;\nstate.mut().day = 0;\nstate.mut().hour = 0;\nstate.mut().minute = 0;\nstate.mut().second = 0;\nstate.mut().millisecond = 0;\nstate.mut().ordinal = 0;\nstate.mut().samples = 0;",
            });
            return { source, script: script(sampleSteps([1, 5, 100])) };
        },
    },

    {
        name: "TimeMonotonicAcrossTicks",
        family: "hostcalls",
        solidity: `${SOL}/various/block_timestamp.sol`,
        stresses:
            "the recomposed clock compared against its previous value on every sample — the monotonicity every lock contract assumes, counted rather than asserted",
        caveat: "Solidity's timestamp is monotonic by consensus rule; here it follows from the tick counter, so the port counts violations instead of reverting.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimeMonotonicAcrossTicks",
                header: {
                    archetype: "TimeMonotonicAcrossTicks",
                    family: "hostcalls",
                    solidity: `${SOL}/various/block_timestamp.sol`,
                    stresses: "monotonicity of the recomposed clock, and the deltas between samples",
                    caveat: "violations are counted, not reverted",
                    axis: "clock monotonicity",
                },
                state: "uint64 previous;\nuint64 samples;\nuint64 regressions;\nuint64 totalDelta;\nuint64 maxDelta;",
                entries: [
                    {
                        name: "Sample",
                        kind: "procedure",
                        number: 1,
                        locals: "uint64 now;\nuint64 delta;",
                        body: `
                            locals.now = (uint64)qpi.hour() * 3600000ULL;
                            locals.now += (uint64)qpi.minute() * 60000ULL;
                            locals.now += (uint64)qpi.second() * 1000ULL;
                            locals.now += (uint64)qpi.millisecond();
                            if (state.get().samples > 0)
                            {
                                if (locals.now < state.get().previous)
                                {
                                    state.mut().regressions++;
                                    locals.delta = 0;
                                }
                                else
                                {
                                    locals.delta = locals.now - state.get().previous;
                                }
                                state.mut().totalDelta += locals.delta;
                                if (locals.delta > state.get().maxDelta)
                                {
                                    state.mut().maxDelta = locals.delta;
                                }
                            }
                            state.mut().previous = locals.now;
                            state.mut().samples++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 previous;\nuint64 samples;\nuint64 regressions;\nuint64 totalDelta;\nuint64 maxDelta;",
                        body: `
                            output.previous = state.get().previous;
                            output.samples = state.get().samples;
                            output.regressions = state.get().regressions;
                            output.totalDelta = state.get().totalDelta;
                            output.maxDelta = state.get().maxDelta;
                        `,
                    },
                ],
                initialize:
                    "state.mut().previous = 0;\nstate.mut().samples = 0;\nstate.mut().regressions = 0;\nstate.mut().totalDelta = 0;\nstate.mut().maxDelta = 0;",
            });
            return { source, script: script(sampleSteps([1, 1, 2, 10])) };
        },
    },

    {
        name: "TimeDayOfWeekLadder",
        family: "hostcalls",
        solidity: "no Solidity analogue (calendar arithmetic)",
        stresses:
            "qpi.dayOfWeek over month ends, a leap day, the year-2000 origin and three deliberately invalid dates — three uint8 arguments in, one uint8 out",
        caveat: "Solidity has no calendar at all; contracts that need one ship a library, so this call has no original to port.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimeDayOfWeekLadder",
                header: {
                    archetype: "TimeDayOfWeekLadder",
                    family: "hostcalls",
                    solidity: "no Solidity analogue",
                    stresses: "dayOfWeek across boundaries and invalid inputs",
                    caveat: "no calendar in Solidity",
                    axis: "day-of-week ladder",
                },
                state: "uint64 sum;\nuint64 queries;\nuint8 last;\nuint64 sundays;",
                entries: [
                    {
                        name: "Ask",
                        kind: "procedure",
                        number: 1,
                        input: "uint8 year;\nuint8 month;\nuint8 day;",
                        locals: "uint8 answer;",
                        body: `
                            locals.answer = qpi.dayOfWeek(input.year, input.month, input.day);
                            state.mut().last = locals.answer;
                            state.mut().sum += (uint64)locals.answer;
                            if (locals.answer == 4)
                            {
                                state.mut().sundays++;
                            }
                            state.mut().queries++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 sum;\nuint64 queries;\nuint8 last;\nuint64 sundays;",
                        body: `
                            output.sum = state.get().sum;
                            output.queries = state.get().queries;
                            output.last = state.get().last;
                            output.sundays = state.get().sundays;
                        `,
                    },
                ],
                initialize: "state.mut().sum = 0;\nstate.mut().queries = 0;\nstate.mut().last = 0;\nstate.mut().sundays = 0;",
            });
            const steps: CallStep[] = [];
            for (const [year, month, day] of [
                [0, 1, 1],
                [24, 2, 29],
                [24, 12, 31],
                [25, 1, 1],
                [99, 12, 31],
                [24, 13, 1],
                [24, 2, 30],
                [24, 0, 0],
            ] as [number, number, number][]) {
                steps.push({ kind: "procedure", entry: 1, in: u8(year) + u8(month) + u8(day), invocator: 0, note: `20${year}-${month}-${day}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "TimeTickEpochRelations",
        family: "hostcalls",
        solidity: `${SOL}/various/block_number.sol`,
        stresses:
            "tick, initialTick, epoch and numberOfTickTransactions read together and related to each other — four counters the host advances at different rates",
        caveat: "Solidity has block.number only; the epoch and the initial tick have no analogue.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimeTickEpochRelations",
                header: {
                    archetype: "TimeTickEpochRelations",
                    family: "hostcalls",
                    solidity: `${SOL}/various/block_number.sol`,
                    stresses: "tick versus initialTick versus epoch, and the per-tick transaction counter",
                    caveat: "no epoch or initial tick in Solidity",
                    axis: "tick and epoch counters",
                },
                state: "uint64 tick;\nuint64 initialTick;\nuint64 epoch;\nuint64 sinceInitial;\nuint64 transactions;\nuint64 samples;",
                entries: [
                    {
                        name: "Sample",
                        kind: "procedure",
                        number: 1,
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().tick = (uint64)qpi.tick();
                            state.mut().initialTick = (uint64)qpi.initialTick();
                            state.mut().epoch = (uint64)qpi.epoch();
                            state.mut().sinceInitial = (uint64)qpi.tick() - (uint64)qpi.initialTick();
                            state.mut().transactions = (uint64)qpi.numberOfTickTransactions();
                            state.mut().samples++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 tick;\nuint64 initialTick;\nuint64 epoch;\nuint64 sinceInitial;\nuint64 transactions;\nuint64 samples;",
                        body: `
                            output.tick = state.get().tick;
                            output.initialTick = state.get().initialTick;
                            output.epoch = state.get().epoch;
                            output.sinceInitial = state.get().sinceInitial;
                            output.transactions = state.get().transactions;
                            output.samples = state.get().samples;
                        `,
                    },
                ],
                initialize:
                    "state.mut().tick = 0;\nstate.mut().initialTick = 0;\nstate.mut().epoch = 0;\nstate.mut().sinceInitial = 0;\nstate.mut().transactions = 0;\nstate.mut().samples = 0;",
            });
            return { source, script: script(sampleSteps([1, 3]), { epochLength: 4 }) };
        },
    },

    {
        name: "TimeDeadlineComparison",
        family: "hostcalls",
        solidity: "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol (deadline checks)",
        stresses:
            "the deadline pattern: a stored ordinal compared against the recomposed clock, with the comparison done once at 64 bits and once truncated to 32",
        caveat: "The Solidity original compares a uint256 deadline to block.timestamp; the port keeps the shape and adds the truncated comparison, which is where the two spellings can disagree.",
        axes: ["placement", "width"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimeDeadlineComparison",
                header: {
                    archetype: "TimeDeadlineComparison",
                    family: "hostcalls",
                    solidity: "EIP712 deadline check",
                    stresses: "a deadline compared at two widths",
                    caveat: "uint256 deadline becomes uint64 and uint32",
                    axis: "deadline widths",
                },
                state: "uint64 deadline;\nuint64 wideAccepted;\nuint64 wideRejected;\nuint64 narrowAccepted;\nuint64 narrowRejected;\nuint64 disagreements;",
                entries: [
                    {
                        name: "SetDeadline",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 deadline;",
                        locals: "uint64 scratch;",
                        body: "state.mut().deadline = input.deadline;",
                    },
                    {
                        name: "Attempt",
                        kind: "procedure",
                        number: 2,
                        output: "uint64 ok;",
                        locals: "uint64 now;\nuint32 nowNarrow;\nuint32 deadlineNarrow;\nuint64 wide;\nuint64 narrow;",
                        body: `
                            locals.now = (uint64)qpi.tick() * 1000ULL + (uint64)qpi.millisecond();
                            locals.nowNarrow = (uint32)locals.now;
                            locals.deadlineNarrow = (uint32)state.get().deadline;
                            locals.wide = locals.now <= state.get().deadline ? 1 : 0;
                            locals.narrow = locals.nowNarrow <= locals.deadlineNarrow ? 1 : 0;
                            if (locals.wide != locals.narrow)
                            {
                                state.mut().disagreements++;
                            }
                            if (locals.wide != 0)
                            {
                                state.mut().wideAccepted++;
                            }
                            else
                            {
                                state.mut().wideRejected++;
                            }
                            if (locals.narrow != 0)
                            {
                                state.mut().narrowAccepted++;
                            }
                            else
                            {
                                state.mut().narrowRejected++;
                            }
                            output.ok = locals.wide;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 wideAccepted;\nuint64 wideRejected;\nuint64 narrowAccepted;\nuint64 narrowRejected;\nuint64 disagreements;",
                        body: `
                            output.wideAccepted = state.get().wideAccepted;
                            output.wideRejected = state.get().wideRejected;
                            output.narrowAccepted = state.get().narrowAccepted;
                            output.narrowRejected = state.get().narrowRejected;
                            output.disagreements = state.get().disagreements;
                        `,
                    },
                ],
                initialize:
                    "state.mut().deadline = 0;\nstate.mut().wideAccepted = 0;\nstate.mut().wideRejected = 0;\nstate.mut().narrowAccepted = 0;\nstate.mut().narrowRejected = 0;\nstate.mut().disagreements = 0;",
            });
            const steps: CallStep[] = [];
            for (const deadline of [0n, 1000000n, 4294967295n, 4294967296n, 18446744073709551615n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(deadline), invocator: 0, note: `deadline ${deadline}` });
                steps.push({ kind: "procedure", entry: 2, invocator: 0 });
                steps.push({ kind: "function", entry: 1 });
                steps.push({ kind: "advanceTick", n: 1 });
            }
            return { source, script: script(steps) };
        },
    },

    {
        name: "TimeReadInHookAndEntry",
        family: "hostcalls",
        solidity: "no Solidity analogue (per-block hook)",
        stresses: "the same clock read from BEGIN_TICK and from an entry in the same tick — two different execution contexts asking the host the same question",
        caveat: "Solidity has no code that runs outside a transaction, so only the entry half has an original.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimeReadInHookAndEntry",
                header: {
                    archetype: "TimeReadInHookAndEntry",
                    family: "hostcalls",
                    solidity: "no Solidity analogue",
                    stresses: "the clock read from a hook and from an entry",
                    caveat: "no out-of-transaction execution in Solidity",
                    axis: "hook versus entry clock",
                },
                state: "uint64 hookTick;\nuint64 entryTick;\nuint64 agreements;\nuint64 disagreements;\nuint64 hookRuns;",
                entries: [
                    {
                        name: "Sample",
                        kind: "procedure",
                        number: 1,
                        locals: "uint64 now;",
                        body: `
                            locals.now = (uint64)qpi.tick();
                            state.mut().entryTick = locals.now;
                            if (locals.now == state.get().hookTick)
                            {
                                state.mut().agreements++;
                            }
                            else
                            {
                                state.mut().disagreements++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 hookTick;\nuint64 entryTick;\nuint64 agreements;\nuint64 disagreements;\nuint64 hookRuns;",
                        body: `
                            output.hookTick = state.get().hookTick;
                            output.entryTick = state.get().entryTick;
                            output.agreements = state.get().agreements;
                            output.disagreements = state.get().disagreements;
                            output.hookRuns = state.get().hookRuns;
                        `,
                    },
                ],
                initialize:
                    "state.mut().hookTick = 0;\nstate.mut().entryTick = 0;\nstate.mut().agreements = 0;\nstate.mut().disagreements = 0;\nstate.mut().hookRuns = 0;",
                beginTick: "state.mut().hookTick = (uint64)qpi.tick();\nstate.mut().hookRuns++;",
            });
            return { source, script: script(sampleSteps([1, 1, 3])) };
        },
    },

    {
        name: "TimePackedDateAndTime",
        family: "hostcalls",
        solidity: "no Solidity analogue (bit-packed timestamp)",
        stresses:
            "the calendar fields packed by hand into one uint64 with shifts and masks, then unpacked and compared field by field — a round trip through bit arithmetic over host-supplied values",
        caveat: "The pattern is common in Solidity (packing a timestamp with flags into one slot); the fields being packed are QPI's, not Solidity's.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimePackedDateAndTime",
                header: {
                    archetype: "TimePackedDateAndTime",
                    family: "hostcalls",
                    solidity: "bit-packed timestamp pattern",
                    stresses: "pack and unpack the calendar through shifts and masks",
                    caveat: "the packing pattern is Solidity's, the fields are QPI's",
                    axis: "packed clock",
                },
                state: "uint64 packed;\nuint64 roundTrips;\nuint64 mismatches;\nuint64 samples;",
                entries: [
                    {
                        name: "Sample",
                        kind: "procedure",
                        number: 1,
                        locals: "uint64 packed;\nuint64 year;\nuint64 month;\nuint64 day;\nuint64 hour;\nuint64 minute;\nuint64 second;",
                        body: `
                            locals.packed = 0;
                            locals.packed = locals.packed | ((uint64)qpi.year() << 40);
                            locals.packed = locals.packed | ((uint64)qpi.month() << 36);
                            locals.packed = locals.packed | ((uint64)qpi.day() << 31);
                            locals.packed = locals.packed | ((uint64)qpi.hour() << 26);
                            locals.packed = locals.packed | ((uint64)qpi.minute() << 20);
                            locals.packed = locals.packed | ((uint64)qpi.second() << 14);
                            state.mut().packed = locals.packed;

                            locals.year = (locals.packed >> 40) & 255ULL;
                            locals.month = (locals.packed >> 36) & 15ULL;
                            locals.day = (locals.packed >> 31) & 31ULL;
                            locals.hour = (locals.packed >> 26) & 31ULL;
                            locals.minute = (locals.packed >> 20) & 63ULL;
                            locals.second = (locals.packed >> 14) & 63ULL;
                            if (locals.year != (uint64)qpi.year() || locals.month != (uint64)qpi.month() || locals.day != (uint64)qpi.day())
                            {
                                state.mut().mismatches++;
                            }
                            else if (locals.hour != (uint64)qpi.hour() || locals.minute != (uint64)qpi.minute() || locals.second != (uint64)qpi.second())
                            {
                                state.mut().mismatches++;
                            }
                            else
                            {
                                state.mut().roundTrips++;
                            }
                            state.mut().samples++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 packed;\nuint64 roundTrips;\nuint64 mismatches;\nuint64 samples;",
                        body: `
                            output.packed = state.get().packed;
                            output.roundTrips = state.get().roundTrips;
                            output.mismatches = state.get().mismatches;
                            output.samples = state.get().samples;
                        `,
                    },
                ],
                initialize: "state.mut().packed = 0;\nstate.mut().roundTrips = 0;\nstate.mut().mismatches = 0;\nstate.mut().samples = 0;",
            });
            // 3,600 ticks of simulator time cost about forty seconds per backend and turned this cell
            // into a reported hang when four workers competed for the machine (F216); 240 exercises the
            // same minute and hour boundaries.
            return { source, script: script(sampleSteps([1, 60, 240])) };
        },
    },

    {
        name: "TimeEpochRolloverSchedule",
        family: "hostcalls",
        solidity: "openzeppelin-contracts/contracts/governance/Governor.sol (voting periods)",
        stresses:
            "a schedule keyed on the epoch counter, with the window opened in BEGIN_EPOCH and closed in END_EPOCH — the host's own period boundary rather than one the contract computes",
        caveat: "Governor measures periods in blocks; QPI's epochs are a protocol-level period the contract does not choose.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TimeEpochRolloverSchedule",
                header: {
                    archetype: "TimeEpochRolloverSchedule",
                    family: "hostcalls",
                    solidity: "Governor voting periods",
                    stresses: "a window opened and closed by the epoch hooks",
                    caveat: "epochs are protocol-level, not contract-chosen",
                    axis: "epoch schedule",
                },
                state: "uint64 windowOpen;\nuint64 accepted;\nuint64 rejected;\nuint64 epochsSeen;\nuint64 lastEpoch;",
                entries: [
                    {
                        name: "Vote",
                        kind: "procedure",
                        number: 1,
                        output: "uint64 ok;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().windowOpen == 0)
                            {
                                state.mut().rejected++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().accepted++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 windowOpen;\nuint64 accepted;\nuint64 rejected;\nuint64 epochsSeen;\nuint64 lastEpoch;",
                        body: `
                            output.windowOpen = state.get().windowOpen;
                            output.accepted = state.get().accepted;
                            output.rejected = state.get().rejected;
                            output.epochsSeen = state.get().epochsSeen;
                            output.lastEpoch = state.get().lastEpoch;
                        `,
                    },
                ],
                initialize:
                    "state.mut().windowOpen = 0;\nstate.mut().accepted = 0;\nstate.mut().rejected = 0;\nstate.mut().epochsSeen = 0;\nstate.mut().lastEpoch = 0;",
                beginEpoch: "state.mut().windowOpen = 1;\nstate.mut().lastEpoch = (uint64)qpi.epoch();\nstate.mut().epochsSeen++;",
                endEpoch: "state.mut().windowOpen = 0;",
            });
            return {
                source,
                script: script(
                    [
                        { kind: "procedure", entry: 1, invocator: 0, note: "before any epoch hook" },
                        { kind: "function", entry: 1 },
                        { kind: "advanceEpoch", n: 1 },
                        { kind: "procedure", entry: 1, invocator: 0, note: "inside the window" },
                        { kind: "function", entry: 1 },
                        { kind: "advanceEpoch", n: 1 },
                        { kind: "procedure", entry: 1, invocator: 0 },
                        { kind: "function", entry: 1 },
                    ],
                    { epochLength: 4 },
                ),
            };
        },
    },
];
