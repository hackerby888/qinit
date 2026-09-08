// Construction and hook interaction, second batch.
//
// Round 3's lifecycle archetypes established that the four hooks run and that INITIALIZE's absence is
// visible. These push further: a hook that writes what a later entry reads, two hooks writing the same
// member, an epoch boundary that arrives between two halves of a computation, and construction-time
// state that the `initStyle` axis then takes away. The last one matters because that axis is universal
// now — every archetype in the corpus is also run with an empty and with an absent INITIALIZE, and this
// family is where that is the subject rather than a side effect.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, AxisAssignment, CallStep } from "../types";

interface HookSpec {
    state: string;
    entries: Parameters<typeof emitContract>[0]["entries"];
    output: string;
    readBody: string;
    initialize?: string;
    initializeLocals?: string;
    beginTick?: string;
    endTick?: string;
    beginEpoch?: string;
    endEpoch?: string;
    beginTickLocals?: string;
    endTickLocals?: string;
    beginEpochLocals?: string;
    endEpochLocals?: string;
    steps: CallStep[];
    prelude?: string;
}

function hookArchetype(meta: Omit<Archetype, "build" | "axes"> & { axes?: Archetype["axes"] }, spec: (axis: AxisAssignment) => HookSpec): Archetype {
    return {
        ...meta,
        axes: meta.axes ?? ["placement"],
        build(axis) {
            const shape = spec(axis);
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: "hook interaction",
                },
                prelude: shape.prelude,
                state: shape.state,
                entries: [...shape.entries, { name: "Read", kind: "function", number: 1, output: shape.output, body: shape.readBody }],
                initialize: shape.initialize,
                initializeLocals: shape.initializeLocals,
                beginTick: shape.beginTick,
                endTick: shape.endTick,
                beginEpoch: shape.beginEpoch,
                endEpoch: shape.endEpoch,
                beginTickLocals: shape.beginTickLocals,
                endTickLocals: shape.endTickLocals,
                beginEpochLocals: shape.beginEpochLocals,
                endEpochLocals: shape.endEpochLocals,
            });
            return { source, script: script(shape.steps, { epochLength: 4 }) };
        },
    };
}

const TOUCH: CallStep = { kind: "procedure", entry: 1, in: u64(1), invocator: 0 };
const READ: CallStep = { kind: "function", entry: 1 };

export const LIFECYCLE_MORE_ARCHETYPES: Archetype[] = [
    hookArchetype(
        {
            name: "HookWritesWhatEntryReads",
            family: "lifecycle",
            solidity: "no Solidity analogue (per-block hook)",
            stresses: "BEGIN_TICK computing a value that the next entry consumes and clears — a producer/consumer pair split across two execution contexts",
        },
        () => ({
            state: "uint64 pending;\nuint64 consumed;\nuint64 produced;\nuint64 missedPickups;",
            entries: [
                {
                    name: "Consume",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 scratch;",
                    body: `
                        if (state.get().pending == 0)
                        {
                            state.mut().missedPickups++;
                        }
                        else
                        {
                            state.mut().consumed += state.get().pending;
                            state.mut().pending = 0;
                        }
                    `,
                },
            ],
            output: "uint64 pending;\nuint64 consumed;\nuint64 produced;\nuint64 missedPickups;",
            readBody: `
                output.pending = state.get().pending;
                output.consumed = state.get().consumed;
                output.produced = state.get().produced;
                output.missedPickups = state.get().missedPickups;
            `,
            initialize: "state.mut().pending = 0;\nstate.mut().consumed = 0;\nstate.mut().produced = 0;\nstate.mut().missedPickups = 0;",
            beginTick: "state.mut().pending += 10;\nstate.mut().produced += 10;",
            steps: [TOUCH, READ, { kind: "advanceTick", n: 1 }, TOUCH, READ, TOUCH, READ, { kind: "advanceTick", n: 2 }, TOUCH, READ],
        }),
    ),

    hookArchetype(
        {
            name: "TwoHooksWriteOneMember",
            family: "lifecycle",
            solidity: "no Solidity analogue",
            stresses:
                "BEGIN_TICK and END_TICK both writing the same member, so its value between them is only observable from an entry that runs in that window",
        },
        () => ({
            state: "uint64 phase;\nuint64 seenInEntry;\nuint64 beginRuns;\nuint64 endRuns;",
            entries: [
                {
                    name: "Observe",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 scratch;",
                    body: "state.mut().seenInEntry = state.get().phase;",
                },
            ],
            output: "uint64 phase;\nuint64 seenInEntry;\nuint64 beginRuns;\nuint64 endRuns;",
            readBody: `
                output.phase = state.get().phase;
                output.seenInEntry = state.get().seenInEntry;
                output.beginRuns = state.get().beginRuns;
                output.endRuns = state.get().endRuns;
            `,
            initialize: "state.mut().phase = 0;\nstate.mut().seenInEntry = 0;\nstate.mut().beginRuns = 0;\nstate.mut().endRuns = 0;",
            beginTick: "state.mut().phase = 1;\nstate.mut().beginRuns++;",
            endTick: "state.mut().phase = 2;\nstate.mut().endRuns++;",
            steps: [TOUCH, READ, { kind: "advanceTick", n: 1 }, TOUCH, READ, { kind: "advanceTick", n: 1 }, READ],
        }),
    ),

    hookArchetype(
        {
            name: "EpochBoundarySplitsComputation",
            family: "lifecycle",
            solidity: "openzeppelin-contracts/contracts/governance/Governor.sol",
            stresses:
                "a two-phase computation where the epoch rolls over between the phases — the second phase has to notice that the window it belonged to has closed",
        },
        () => ({
            state: "uint64 phaseOneEpoch;\nuint64 phaseTwoEpoch;\nuint64 straddled;\nuint64 completed;\nuint64 started;",
            entries: [
                {
                    name: "Begin",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 scratch;",
                    body: "state.mut().phaseOneEpoch = (uint64)qpi.epoch();\nstate.mut().started++;",
                },
                {
                    name: "Finish",
                    kind: "procedure",
                    number: 2,
                    locals: "uint64 scratch;",
                    body: `
                        state.mut().phaseTwoEpoch = (uint64)qpi.epoch();
                        if (state.get().phaseTwoEpoch != state.get().phaseOneEpoch)
                        {
                            state.mut().straddled++;
                        }
                        else
                        {
                            state.mut().completed++;
                        }
                    `,
                },
            ],
            output: "uint64 phaseOneEpoch;\nuint64 phaseTwoEpoch;\nuint64 straddled;\nuint64 completed;\nuint64 started;",
            readBody: `
                output.phaseOneEpoch = state.get().phaseOneEpoch;
                output.phaseTwoEpoch = state.get().phaseTwoEpoch;
                output.straddled = state.get().straddled;
                output.completed = state.get().completed;
                output.started = state.get().started;
            `,
            initialize:
                "state.mut().phaseOneEpoch = 0;\nstate.mut().phaseTwoEpoch = 0;\nstate.mut().straddled = 0;\nstate.mut().completed = 0;\nstate.mut().started = 0;",
            steps: [
                TOUCH,
                { kind: "procedure", entry: 2, invocator: 0, note: "same epoch" },
                READ,
                TOUCH,
                { kind: "advanceEpoch", n: 1 },
                { kind: "procedure", entry: 2, invocator: 0, note: "the epoch moved under it" },
                READ,
            ],
        }),
    ),

    hookArchetype(
        {
            name: "InitialisedFlagAgainstAbsentInitialize",
            family: "lifecycle",
            solidity: "openzeppelin-contracts/contracts/proxy/utils/Initializable.sol",
            stresses:
                "a contract that checks a construction-time flag before doing anything — under the initStyle axis the flag is sometimes never set, and then every entry has to take the refusal path",
            caveat: "This archetype is written to be *interesting* under `initStyle=absent`, which the generator applies to everything: with no INITIALIZE the flag is whatever construction leaves, and both backends have to agree on that.",
            axes: ["placement", "initStyle"],
        },
        () => ({
            state: "uint64 ready;\nuint64 accepted;\nuint64 refused;\nuint64 total;",
            entries: [
                {
                    name: "Use",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;",
                    output: "uint64 ok;",
                    locals: "uint64 scratch;",
                    body: `
                        if (state.get().ready != 1)
                        {
                            state.mut().refused++;
                            output.ok = 0;
                            return;
                        }
                        state.mut().accepted++;
                        state.mut().total += input.amount;
                        output.ok = 1;
                    `,
                },
                {
                    name: "Repair",
                    kind: "procedure",
                    number: 2,
                    locals: "uint64 scratch;",
                    body: "state.mut().ready = 1;",
                },
            ],
            output: "uint64 ready;\nuint64 accepted;\nuint64 refused;\nuint64 total;",
            readBody: `
                output.ready = state.get().ready;
                output.accepted = state.get().accepted;
                output.refused = state.get().refused;
                output.total = state.get().total;
            `,
            initialize: "state.mut().ready = 1;\nstate.mut().accepted = 0;\nstate.mut().refused = 0;\nstate.mut().total = 0;",
            steps: [
                { kind: "procedure", entry: 1, in: u64(5), invocator: 0 },
                READ,
                { kind: "procedure", entry: 2, invocator: 0, note: "set the flag by hand" },
                { kind: "procedure", entry: 1, in: u64(5), invocator: 0 },
                READ,
                { kind: "advanceTick", n: 1 },
            ],
        }),
    ),

    hookArchetype(
        {
            name: "TickCounterDrivesSchedule",
            family: "lifecycle",
            solidity: "no Solidity analogue (block-number schedule)",
            stresses:
                "a schedule kept entirely in the tick hook — every fourth tick does extra work, and an entry can only observe how many times that happened",
        },
        () => ({
            state: "uint64 ticks;\nuint64 quarters;\nuint64 lastQuarterTick;\nuint64 observations;",
            entries: [
                {
                    name: "Observe",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 scratch;",
                    body: "state.mut().observations++;",
                },
            ],
            output: "uint64 ticks;\nuint64 quarters;\nuint64 lastQuarterTick;\nuint64 observations;",
            readBody: `
                output.ticks = state.get().ticks;
                output.quarters = state.get().quarters;
                output.lastQuarterTick = state.get().lastQuarterTick;
                output.observations = state.get().observations;
            `,
            initialize: "state.mut().ticks = 0;\nstate.mut().quarters = 0;\nstate.mut().lastQuarterTick = 0;\nstate.mut().observations = 0;",
            beginTick: `
                state.mut().ticks++;
                if (QPI::mod((uint64)qpi.tick(), 4ULL) == 0)
                {
                    state.mut().quarters++;
                    state.mut().lastQuarterTick = (uint64)qpi.tick();
                }
            `,
            steps: [READ, { kind: "advanceTick", n: 1 }, READ, { kind: "advanceTick", n: 3 }, READ, TOUCH, { kind: "advanceTick", n: 4 }, READ],
        }),
    ),

    hookArchetype(
        {
            name: "EndEpochResetsPerEpochCounters",
            family: "lifecycle",
            solidity: "no Solidity analogue (period reset)",
            stresses:
                "per-epoch counters zeroed by END_EPOCH with their totals carried forward — the reset and the carry have to happen in that order or the total loses an epoch",
        },
        () => ({
            state: "uint64 thisEpoch;\nuint64 lifetime;\nuint64 epochsClosed;\nuint64 largestEpoch;",
            entries: [
                {
                    name: "Record",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 amount;",
                    locals: "uint64 scratch;",
                    body: "state.mut().thisEpoch += input.amount;",
                },
            ],
            output: "uint64 thisEpoch;\nuint64 lifetime;\nuint64 epochsClosed;\nuint64 largestEpoch;",
            readBody: `
                output.thisEpoch = state.get().thisEpoch;
                output.lifetime = state.get().lifetime;
                output.epochsClosed = state.get().epochsClosed;
                output.largestEpoch = state.get().largestEpoch;
            `,
            initialize: "state.mut().thisEpoch = 0;\nstate.mut().lifetime = 0;\nstate.mut().epochsClosed = 0;\nstate.mut().largestEpoch = 0;",
            endEpoch: `
                state.mut().lifetime += state.get().thisEpoch;
                if (state.get().thisEpoch > state.get().largestEpoch)
                {
                    state.mut().largestEpoch = state.get().thisEpoch;
                }
                state.mut().thisEpoch = 0;
                state.mut().epochsClosed++;
            `,
            steps: [
                { kind: "procedure", entry: 1, in: u64(5), invocator: 0 },
                { kind: "procedure", entry: 1, in: u64(7), invocator: 0 },
                READ,
                { kind: "advanceEpoch", n: 1 },
                READ,
                { kind: "procedure", entry: 1, in: u64(3), invocator: 0 },
                { kind: "advanceEpoch", n: 1 },
                READ,
            ],
        }),
    ),

    hookArchetype(
        {
            name: "BeginEpochSeedsFromDigest",
            family: "lifecycle",
            solidity: "not-so-smart-contracts/bad_randomness",
            stresses:
                "a per-epoch seed derived in BEGIN_EPOCH from the previous spectrum digest and the epoch number — the only place a contract can refresh a seed without a caller",
        },
        () => ({
            state: "uint64 seedWord;\nuint64 refreshes;\nuint64 draws;\nuint64 lastDraw;",
            entries: [
                {
                    name: "Draw",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 scratch;",
                    body: `
                        state.mut().lastDraw = QPI::mod(state.get().seedWord + state.get().draws, 1000ULL);
                        state.mut().draws++;
                    `,
                },
            ],
            output: "uint64 seedWord;\nuint64 refreshes;\nuint64 draws;\nuint64 lastDraw;",
            readBody: `
                output.seedWord = state.get().seedWord;
                output.refreshes = state.get().refreshes;
                output.draws = state.get().draws;
                output.lastDraw = state.get().lastDraw;
            `,
            initialize: "state.mut().seedWord = 0;\nstate.mut().refreshes = 0;\nstate.mut().draws = 0;\nstate.mut().lastDraw = 0;",
            beginEpochLocals: "id digest;\nuint64 epoch;",
            beginEpoch: `
                locals.epoch = (uint64)qpi.epoch();
                locals.digest = qpi.getPrevSpectrumDigest();
                state.mut().seedWord = locals.digest.u64._0 ^ locals.epoch;
                state.mut().refreshes++;
            `,
            steps: [TOUCH, READ, { kind: "advanceEpoch", n: 1 }, TOUCH, READ, { kind: "advanceEpoch", n: 1 }, TOUCH, READ],
        }),
    ),

    hookArchetype(
        {
            name: "InitializeFillsContainerThenHooksTouchIt",
            family: "lifecycle",
            solidity: "test/libsolidity/semanticTests/constructor/constructor_static_array_argument.sol",
            stresses:
                "a container filled at construction and then rotated one slot per tick by the hook — construction-time state that hook code keeps moving, with no entry involved",
        },
        () => ({
            state: "Array<uint64, 8> ring;\nuint64 rotations;\nuint64 checksum;",
            entries: [
                {
                    name: "Peek",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 i;\nuint64 sum;",
                    body: `
                        locals.sum = 0;
                        for (locals.i = 0; locals.i < 8; locals.i++)
                        {
                            locals.sum += state.get().ring.get(locals.i);
                        }
                        state.mut().checksum = locals.sum;
                    `,
                },
            ],
            output: "uint64 rotations;\nuint64 checksum;\nuint64 first;\nuint64 last;",
            readBody: `
                output.rotations = state.get().rotations;
                output.checksum = state.get().checksum;
                output.first = state.get().ring.get(0);
                output.last = state.get().ring.get(7);
            `,
            initializeLocals: "uint64 i;",
            initialize: `
                state.mut().rotations = 0;
                state.mut().checksum = 0;
                for (locals.i = 0; locals.i < 8; locals.i++)
                {
                    state.mut().ring.set(locals.i, locals.i + 1);
                }
            `,
            endTickLocals: "uint64 i;\nuint64 first;",
            endTick: `
                locals.first = state.get().ring.get(0);
                for (locals.i = 0; locals.i < 7; locals.i++)
                {
                    state.mut().ring.set(locals.i, state.get().ring.get(locals.i + 1));
                }
                state.mut().ring.set(7, locals.first);
                state.mut().rotations++;
            `,
            steps: [TOUCH, READ, { kind: "advanceTick", n: 1 }, TOUCH, READ, { kind: "advanceTick", n: 3 }, TOUCH, READ],
        }),
    ),

    hookArchetype(
        {
            name: "HookRefusesWhenStateUninitialised",
            family: "lifecycle",
            solidity: "openzeppelin-contracts/contracts/proxy/utils/Initializable.sol",
            stresses:
                "a tick hook that does nothing until an entry has run once — the guard lives in hook code, where a wrong initial value means the hook either never starts or starts immediately",
            axes: ["placement", "initStyle"],
        },
        () => ({
            state: "uint64 armed;\nuint64 hookRuns;\nuint64 hookSkips;\nuint64 accrued;",
            entries: [
                {
                    name: "Arm",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 scratch;",
                    body: "state.mut().armed = 1;",
                },
            ],
            output: "uint64 armed;\nuint64 hookRuns;\nuint64 hookSkips;\nuint64 accrued;",
            readBody: `
                output.armed = state.get().armed;
                output.hookRuns = state.get().hookRuns;
                output.hookSkips = state.get().hookSkips;
                output.accrued = state.get().accrued;
            `,
            initialize: "state.mut().armed = 0;\nstate.mut().hookRuns = 0;\nstate.mut().hookSkips = 0;\nstate.mut().accrued = 0;",
            beginTick: `
                if (state.get().armed == 0)
                {
                    state.mut().hookSkips++;
                }
                else
                {
                    state.mut().accrued += 7;
                    state.mut().hookRuns++;
                }
            `,
            steps: [{ kind: "advanceTick", n: 2 }, READ, TOUCH, { kind: "advanceTick", n: 2 }, READ, { kind: "advanceTick", n: 1 }, READ],
        }),
    ),

    hookArchetype(
        {
            name: "AllFourHooksAccumulateSeparately",
            family: "lifecycle",
            solidity: "no Solidity analogue",
            stresses: "each of the four hooks incrementing its own counter with a different stride, so the four totals encode exactly how many times each ran",
        },
        () => ({
            state: "uint64 beginTicks;\nuint64 endTicks;\nuint64 beginEpochs;\nuint64 endEpochs;\nuint64 weighted;",
            entries: [
                {
                    name: "Touch",
                    kind: "procedure",
                    number: 1,
                    input: "uint64 unused;",
                    locals: "uint64 scratch;",
                    body: "state.mut().weighted += 1;",
                },
            ],
            output: "uint64 beginTicks;\nuint64 endTicks;\nuint64 beginEpochs;\nuint64 endEpochs;\nuint64 weighted;",
            readBody: `
                output.beginTicks = state.get().beginTicks;
                output.endTicks = state.get().endTicks;
                output.beginEpochs = state.get().beginEpochs;
                output.endEpochs = state.get().endEpochs;
                output.weighted = state.get().weighted;
            `,
            initialize:
                "state.mut().beginTicks = 0;\nstate.mut().endTicks = 0;\nstate.mut().beginEpochs = 0;\nstate.mut().endEpochs = 0;\nstate.mut().weighted = 0;",
            beginTick: "state.mut().beginTicks++;\nstate.mut().weighted += 10;",
            endTick: "state.mut().endTicks++;\nstate.mut().weighted += 100;",
            beginEpoch: "state.mut().beginEpochs++;\nstate.mut().weighted += 1000;",
            endEpoch: "state.mut().endEpochs++;\nstate.mut().weighted += 10000;",
            steps: [READ, { kind: "advanceTick", n: 1 }, READ, TOUCH, { kind: "advanceEpoch", n: 1 }, READ, { kind: "advanceTick", n: 2 }, READ],
        }),
    ),
];
