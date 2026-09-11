// Construction and the hooks that run without a user call.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

export const LIFECYCLE_CONSTRUCTION_ARCHETYPES: Archetype[] = [
    {
        name: "InitializeArrayFillPattern",
        family: "lifecycle",
        solidity: `${SOL}/constructor/constructor_static_array_argument.sol`,
        stresses:
            "an INITIALIZE that computes its values in a loop rather than assigning constants — construction-time control flow, which only the first digest can catch",
        caveat: "Solidity's constructor takes the array as an argument; INITIALIZE has no parameters, so the pattern is computed.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = capacityOf(axis, 16);
            const source = emitContract({
                axis,
                name: "InitializeArrayFillPattern",
                header: {
                    archetype: "InitializeArrayFillPattern",
                    family: "lifecycle",
                    solidity: `${SOL}/constructor/constructor_static_array_argument.sol`,
                    stresses: "a loop inside INITIALIZE, with a running checksum",
                    caveat: "constructor arguments become a computed pattern",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> pattern;\nuint64 checksum;\nuint64 writes;`,
                entries: [
                    {
                        name: "Poke",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;\nuint64 value;",
                        locals: "uint64 previous;",
                        body: `
                            locals.previous = state.get().pattern.get(input.index);
                            state.mut().pattern.set(input.index, input.value);
                            state.mut().checksum += input.value - locals.previous;
                            state.mut().writes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 checksum;\nuint64 writes;\nuint64 first;\nuint64 last;",
                        body: `
                            output.checksum = state.get().checksum;
                            output.writes = state.get().writes;
                            output.first = state.get().pattern.get(0);
                            output.last = state.get().pattern.get(${capacity - 1});
                        `,
                    },
                ],
                initializeLocals: "uint64 i;",
                initialize: `
                    state.mut().checksum = 0;
                    state.mut().writes = 0;
                    for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                    {
                        state.mut().pattern.set(locals.i, locals.i * 3 + 1);
                        state.mut().checksum += locals.i * 3 + 1;
                    }
                `,
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1, note: "pure construction state" },
                    { kind: "procedure", entry: 1, in: u64(0) + u64(9999), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(capacity - 1) + u64(1), invocator: 0, note: "last slot" },
                    { kind: "procedure", entry: 1, in: u64(capacity) + u64(7), invocator: 0, note: "index == capacity — Array::set masks" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "InitializePartialLeavesRestZero",
        family: "lifecycle",
        solidity: `${SOL}/constructor/constructor_static_array_argument.sol`,
        stresses: "members no initialiser ever touches, next to members it sets — the two backends must zero the untouched ones identically",
        caveat: "Solidity guarantees zero-initialised storage; QPI leaves it to the host's construction, which is what this compares.",
        axes: ["placement", "layout"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "InitializePartialLeavesRestZero",
                header: {
                    archetype: "InitializePartialLeavesRestZero",
                    family: "lifecycle",
                    solidity: `${SOL}/constructor/constructor_static_array_argument.sol`,
                    stresses: "half-initialised state, read straight back",
                    caveat: "Solidity zero-initialises storage by definition",
                    axis: "partial initialisation",
                },
                state: "uint64 setEarly;\nuint32 neverSet;\nuint8 flag;\nid owner;\nArray<uint64, 4> touched;\nArray<uint64, 4> untouched;\nuint64 setLate;",
                entries: [
                    {
                        name: "Bump",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 delta;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = state.get().setEarly + input.delta;
                            state.mut().setEarly = locals.scratch;
                            state.mut().setLate = locals.scratch * 2;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 setEarly;\nuint32 neverSet;\nuint8 flag;\nuint64 touchedZero;\nuint64 untouchedZero;\nuint64 setLate;\nuint64 ownerIsNull;",
                        body: `
                            output.setEarly = state.get().setEarly;
                            output.neverSet = state.get().neverSet;
                            output.flag = state.get().flag;
                            output.touchedZero = state.get().touched.get(0);
                            output.untouchedZero = state.get().untouched.get(0);
                            output.setLate = state.get().setLate;
                            output.ownerIsNull = state.get().owner == NULL_ID ? 1 : 0;
                        `,
                    },
                ],
                initialize: `
                    state.mut().setEarly = 5;
                    state.mut().touched.setAll(11);
                    state.mut().setLate = 6;
                `,
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1, note: "before any mutation" },
                    { kind: "procedure", entry: 1, in: u64(3), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "InitializeGuardsSecondConstruction",
        family: "lifecycle",
        solidity: "openzeppelin-contracts/proxy/utils/Initializable.sol",
        stresses: "the initialised flag pattern — INITIALIZE claims ownership once, and a later call that tries to claim it again must be refused",
        caveat: "OpenZeppelin's Initializable guards a proxy's initialiser against a second call; QPI runs INITIALIZE exactly once on deployment, so the port drives the second claim through an entry.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "InitializeGuardsSecondConstruction",
                header: {
                    archetype: "InitializeGuardsSecondConstruction",
                    family: "lifecycle",
                    solidity: "openzeppelin Initializable",
                    stresses: "an initialised flag set at construction and checked at every entry",
                    caveat: "the second initialisation arrives through an entry, not a second INITIALIZE",
                    axis: "initialised flag",
                },
                state: "id owner;\nuint64 initialisedVersion;\nuint64 takeovers;\nuint64 refused;",
                entries: [
                    {
                        name: "Claim",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 version;",
                        output: "uint64 ok;",
                        locals: "id who;",
                        body: `
                            locals.who = qpi.invocator();
                            if (state.get().initialisedVersion >= input.version)
                            {
                                state.mut().refused++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().owner = locals.who;
                            state.mut().initialisedVersion = input.version;
                            state.mut().takeovers++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 initialisedVersion;\nuint64 takeovers;\nuint64 refused;\nuint64 ownerIsSelf;",
                        body: `
                            output.initialisedVersion = state.get().initialisedVersion;
                            output.takeovers = state.get().takeovers;
                            output.refused = state.get().refused;
                            output.ownerIsSelf = state.get().owner == SELF ? 1 : 0;
                        `,
                    },
                ],
                initialize: `
                    state.mut().owner = SELF;
                    state.mut().initialisedVersion = 1;
                    state.mut().takeovers = 0;
                    state.mut().refused = 0;
                `,
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(1), invocator: 0, note: "same version — refused when INITIALIZE ran" },
                    { kind: "procedure", entry: 1, in: u64(2), invocator: 1, note: "higher version — accepted" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(2), invocator: 0, note: "replay of the accepted version" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "BeginTickDerivesFromTickNumber",
        family: "lifecycle",
        solidity: "no Solidity analogue (block.number in a modifier)",
        stresses: "BEGIN_TICK reading qpi.tick() and folding it into state — hook code whose input is the host's tick counter rather than an entry's arguments",
        caveat: "Solidity has no per-block hook; the nearest shape is a modifier that reads block.number, which the port moves into BEGIN_TICK.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "BeginTickDerivesFromTickNumber",
                header: {
                    archetype: "BeginTickDerivesFromTickNumber",
                    family: "lifecycle",
                    solidity: "block.number read in a modifier",
                    stresses: "qpi.tick() inside BEGIN_TICK, accumulated across ticks",
                    caveat: "no Solidity per-block hook exists",
                    axis: "tick-derived accumulation",
                },
                state: "uint64 tickSum;\nuint64 lastTick;\nuint64 ticksSeen;\nuint64 userCalls;",
                entries: [
                    {
                        name: "Touch",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 scratch;",
                        body: `
                            locals.scratch = (uint64)qpi.tick();
                            state.mut().userCalls += input.value + locals.scratch - state.get().lastTick;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 tickSum;\nuint64 lastTick;\nuint64 ticksSeen;\nuint64 userCalls;",
                        body: `
                            output.tickSum = state.get().tickSum;
                            output.lastTick = state.get().lastTick;
                            output.ticksSeen = state.get().ticksSeen;
                            output.userCalls = state.get().userCalls;
                        `,
                    },
                ],
                initialize: "state.mut().tickSum = 0;\nstate.mut().lastTick = 0;\nstate.mut().ticksSeen = 0;\nstate.mut().userCalls = 0;",
                beginTick: `
                    state.mut().lastTick = (uint64)qpi.tick();
                    state.mut().tickSum += (uint64)qpi.tick();
                    state.mut().ticksSeen++;
                `,
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 2 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(4), invocator: 0 },
                    { kind: "advanceTick", n: 3 },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    },

    {
        name: "EndEpochSettlesAndCarries",
        family: "lifecycle",
        solidity: "no Solidity analogue (period settlement)",
        stresses: "END_EPOCH draining a per-epoch accumulator into a lifetime total and leaving a carry — settlement arithmetic that runs between user calls",
        caveat: "Solidity contracts settle on a call; QPI settles in the epoch hook, so the port moves the same arithmetic there.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EndEpochSettlesAndCarries",
                header: {
                    archetype: "EndEpochSettlesAndCarries",
                    family: "lifecycle",
                    solidity: "period settlement moved into END_EPOCH",
                    stresses: "divide-and-carry arithmetic inside the epoch hook",
                    caveat: "settlement runs in a hook rather than on a call",
                    axis: "epoch settlement",
                },
                state: "uint64 pending;\nuint64 settled;\nuint64 carry;\nuint64 epochsSettled;",
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
                        output: "uint64 pending;\nuint64 settled;\nuint64 carry;\nuint64 epochsSettled;",
                        body: `
                            output.pending = state.get().pending;
                            output.settled = state.get().settled;
                            output.carry = state.get().carry;
                            output.epochsSettled = state.get().epochsSettled;
                        `,
                    },
                ],
                initialize: "state.mut().pending = 0;\nstate.mut().settled = 0;\nstate.mut().carry = 0;\nstate.mut().epochsSettled = 0;",
                endEpoch: `
                    state.mut().settled += QPI::div(state.get().pending + state.get().carry, 10ULL) * 10ULL;
                    state.mut().carry = QPI::mod(state.get().pending + state.get().carry, 10ULL);
                    state.mut().pending = 0;
                    state.mut().epochsSettled++;
                `,
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(37), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceEpoch", n: 1 },
                    { kind: "function", entry: 1, note: "after one settlement — 30 settled, 7 carried" },
                    { kind: "procedure", entry: 1, in: u64(6), invocator: 0 },
                    { kind: "advanceEpoch", n: 1 },
                    { kind: "function", entry: 1, note: "carry crosses the boundary" },
                    { kind: "advanceEpoch", n: 1 },
                    { kind: "function", entry: 1, note: "an epoch with nothing pending" },
                ]),
            };
        },
    },

    {
        name: "HookOrderSequenceStamp",
        family: "lifecycle",
        solidity: "no Solidity analogue (hook ordering)",
        stresses: "all four hooks stamping one monotonically increasing sequence counter — the order they run in, made visible in state",
        caveat: "There is no Solidity analogue; the value here is that hook ordering is a host contract both backends must implement identically.",
        axes: [],
        build(axis) {
            const stamp = (member: string) => `state.mut().sequence++;\nstate.mut().${member} = state.get().sequence;`;
            const source = emitContract({
                axis,
                name: "HookOrderSequenceStamp",
                header: {
                    archetype: "HookOrderSequenceStamp",
                    family: "lifecycle",
                    solidity: "no Solidity analogue",
                    stresses: "the relative order of INITIALIZE, BEGIN_EPOCH, BEGIN_TICK, END_TICK and END_EPOCH",
                    caveat: "hook ordering is a host contract, not a language feature",
                    axis: "base",
                },
                state: "uint64 sequence;\nuint64 atInitialize;\nuint64 atBeginEpoch;\nuint64 atBeginTick;\nuint64 atEndTick;\nuint64 atEndEpoch;\nuint64 atCall;",
                entries: [
                    {
                        name: "Touch",
                        kind: "procedure",
                        number: 1,
                        locals: "uint64 scratch;",
                        body: stamp("atCall"),
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 sequence;\nuint64 atInitialize;\nuint64 atBeginEpoch;\nuint64 atBeginTick;\nuint64 atEndTick;\nuint64 atEndEpoch;\nuint64 atCall;",
                        body: `
                            output.sequence = state.get().sequence;
                            output.atInitialize = state.get().atInitialize;
                            output.atBeginEpoch = state.get().atBeginEpoch;
                            output.atBeginTick = state.get().atBeginTick;
                            output.atEndTick = state.get().atEndTick;
                            output.atEndEpoch = state.get().atEndEpoch;
                            output.atCall = state.get().atCall;
                        `,
                    },
                ],
                initialize: `state.mut().sequence = 0;\n${stamp("atInitialize")}`,
                beginTick: stamp("atBeginTick"),
                endTick: stamp("atEndTick"),
                beginEpoch: stamp("atBeginEpoch"),
                endEpoch: stamp("atEndEpoch"),
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                    { kind: "procedure", entry: 1, invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceEpoch", n: 1 },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    },

    {
        name: "IdleTicksMoveOnlyHookState",
        family: "lifecycle",
        solidity: `${SOL}/state/state_variables_view.sol`,
        stresses: "many ticks with no user call — the negative control for the hook family: nothing but the hook counters may move",
        caveat: "Solidity has no idle-block execution at all; this exists to bound what tick advancement is allowed to change.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "IdleTicksMoveOnlyHookState",
                header: {
                    archetype: "IdleTicksMoveOnlyHookState",
                    family: "lifecycle",
                    solidity: `${SOL}/state/state_variables_view.sol`,
                    stresses: "state that must not move while ticks pass",
                    caveat: "negative control — a payload digest that moves across idle ticks is a finding on its own",
                    axis: "base",
                },
                state: "uint64 payload;\nArray<uint64, 8> table;\nuint64 idleTicks;",
                entries: [
                    {
                        name: "Set",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 value;",
                        locals: "uint64 i;",
                        body: `
                            state.mut().payload = input.value;
                            for (locals.i = 0; locals.i < 8; locals.i++)
                            {
                                state.mut().table.set(locals.i, input.value + locals.i);
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 payload;\nuint64 tableSeven;\nuint64 idleTicks;",
                        body: `
                            output.payload = state.get().payload;
                            output.tableSeven = state.get().table.get(7);
                            output.idleTicks = state.get().idleTicks;
                        `,
                    },
                ],
                initialize: "state.mut().payload = 0;\nstate.mut().table.setAll(0);\nstate.mut().idleTicks = 0;",
                endTick: "state.mut().idleTicks++;",
            });
            const steps: CallStep[] = [
                { kind: "procedure", entry: 1, in: u64(1234), invocator: 0 },
                { kind: "function", entry: 1 },
            ];
            for (let i = 0; i < 6; i++) {
                steps.push({ kind: "advanceTick", n: 1 });
                steps.push({ kind: "function", entry: 1, note: "only idleTicks may have moved" });
            }
            return { source, script: script(steps) };
        },
    },

    {
        name: "EpochLengthBoundaryRollover",
        family: "lifecycle",
        solidity: "no Solidity analogue (epoch rollover)",
        stresses: "ticks driven right across an epoch boundary, so BEGIN_EPOCH and END_EPOCH interleave with BEGIN_TICK and END_TICK",
        caveat: "The epoch length is pinned short so a script can actually reach the rollover; on the network it is three thousand ticks.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EpochLengthBoundaryRollover",
                header: {
                    archetype: "EpochLengthBoundaryRollover",
                    family: "lifecycle",
                    solidity: "no Solidity analogue",
                    stresses: "tick and epoch hooks interleaving at a rollover",
                    caveat: "epoch length pinned to 4 for the script",
                    axis: "base",
                },
                state: "uint64 ticksThisEpoch;\nuint64 maxTicksInAnyEpoch;\nuint64 epochs;\nuint64 totalTicks;",
                entries: [
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 ticksThisEpoch;\nuint64 maxTicksInAnyEpoch;\nuint64 epochs;\nuint64 totalTicks;",
                        body: `
                            output.ticksThisEpoch = state.get().ticksThisEpoch;
                            output.maxTicksInAnyEpoch = state.get().maxTicksInAnyEpoch;
                            output.epochs = state.get().epochs;
                            output.totalTicks = state.get().totalTicks;
                        `,
                    },
                    {
                        name: "Noop",
                        kind: "procedure",
                        number: 1,
                        locals: "uint64 scratch;",
                        body: "locals.scratch = state.get().totalTicks;",
                    },
                ],
                initialize: "state.mut().ticksThisEpoch = 0;\nstate.mut().maxTicksInAnyEpoch = 0;\nstate.mut().epochs = 0;\nstate.mut().totalTicks = 0;",
                beginTick: "state.mut().ticksThisEpoch++;\nstate.mut().totalTicks++;",
                endEpoch: `
                    if (state.get().ticksThisEpoch > state.get().maxTicksInAnyEpoch)
                    {
                        state.mut().maxTicksInAnyEpoch = state.get().ticksThisEpoch;
                    }
                    state.mut().ticksThisEpoch = 0;
                    state.mut().epochs++;
                `,
            });
            const steps: CallStep[] = [{ kind: "function", entry: 1 }];
            for (let i = 0; i < 9; i++) {
                steps.push({ kind: "advanceTick", n: 1 });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "procedure", entry: 1, invocator: 0 });
            steps.push({ kind: "function", entry: 1 });
            return { source, script: script(steps, { epochLength: 4 }) };
        },
    },
];
