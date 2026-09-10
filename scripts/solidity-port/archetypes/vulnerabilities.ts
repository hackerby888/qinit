// Vulnerability archetypes.
//
// Ported from crytic/not-so-smart-contracts and the SmartBugs taxonomy: the shapes behind real
// exploits. Several of the original bugs are not expressible in QPI at all — there is no reentrancy
// through an external call, because the call graph is a strict DAG by slot, and there is no
// selfdestruct or delegatecall. Those are ported to the nearest QPI-legal shape, and the header comment
// of every emitted file says which. Their value here is not security coverage; it is that real exploit
// code has a shape hand-written probes do not.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

export const VULNERABILITY_ARCHETYPES: Archetype[] = [
    {
        name: "BatchOverflowMulCount",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/integer_overflow (BeautyChain BEC batchTransfer, 2018)",
        stresses: "`count * value` overflowing before the balance check — the multiplication that let BEC mint 2^255 tokens",
        caveat: "The original overflows at 2^256; ported to uint64 the boundary moves, but the shape — an unchecked product feeding a checked subtraction — is identical.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "BatchOverflowMulCount",
                header: {
                    archetype: "BatchOverflowMulCount",
                    family: "vulnerabilities",
                    solidity: "BeautyChain batchTransfer (SWC-101)",
                    stresses: "an unchecked product used as the amount in a checked subtraction",
                    caveat: "overflow boundary moves from 2^256 to 2^64",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> recipients;\nuint64 senderBalance;\nuint64 totalSent;\nuint64 accepted;\nuint64 rejected;`,
                entries: [
                    {
                        name: "BatchTransfer",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;\nuint64 value;",
                        output: "uint64 ok;",
                        locals: "uint64 total;\nuint64 i;\nuint64 bounded;",
                        body: `
                            // The exploit: this product wraps, so the guard below sees a small total.
                            locals.total = input.count * input.value;
                            if (state.get().senderBalance < locals.total)
                            {
                                state.mut().rejected++;
                                output.ok = 0;
                                return;
                            }
                            locals.bounded = input.count;
                            if (locals.bounded > ${capacity})
                            {
                                locals.bounded = ${capacity};
                            }
                            for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                            {
                                state.mut().recipients.set(locals.i, state.get().recipients.get(locals.i) + input.value);
                            }
                            state.mut().senderBalance -= locals.total;
                            state.mut().totalSent += locals.total;
                            state.mut().accepted++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 senderBalance;\nuint64 totalSent;\nuint64 accepted;\nuint64 rejected;\nuint64 firstRecipient;",
                        body: `
                            output.senderBalance = state.get().senderBalance;
                            output.totalSent = state.get().totalSent;
                            output.accepted = state.get().accepted;
                            output.rejected = state.get().rejected;
                            output.firstRecipient = state.get().recipients.get(0);
                        `,
                    },
                ],
                initialize: "state.mut().recipients.setAll(0);\nstate.mut().senderBalance = 1000;\nstate.mut().totalSent = 0;\nstate.mut().accepted = 0;\nstate.mut().rejected = 0;",
            });
            const steps: CallStep[] = [];
            for (const [count, value] of [
                [2n, 100n],
                [2n, 9223372036854775808n],
                [4n, 4611686018427387904n],
                [0n, 500n],
                [3n, 1000n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(count) + u64(value), invocator: 0, note: `${count} x ${value}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "ReentrancyStateMachine",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/reentrancy (The DAO, 2016)",
        stresses: "interaction-before-effect versus checks-effects-interactions, expressed as a re-entry flag rather than a real callback",
        caveat: "QPI's call graph is a strict DAG by slot, so a callee cannot re-enter its caller: classic reentrancy is structurally impossible. The port models the re-entry as a second entry reached while a guard flag is set, which is the state-machine residue of the same bug.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "ReentrancyStateMachine",
                header: {
                    archetype: "ReentrancyStateMachine",
                    family: "vulnerabilities",
                    solidity: "The DAO recursive split (SWC-107)",
                    stresses: "guard-flag ordering around a withdrawal",
                    caveat: "no real reentrancy in QPI — the DAG forbids it; this is the state-machine residue",
                    axis: "base",
                },
                state: "uint64 balance;\nuint64 paidOut;\nbit inCall;\nuint64 reentered;\nuint64 badOrderBalance;",
                entries: [
                    {
                        name: "WithdrawBadOrder",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().balance < input.amount)
                            {
                                output.ok = 0;
                                return;
                            }
                            if (state.get().inCall == 1)
                            {
                                state.mut().reentered++;
                            }
                            state.mut().inCall = 1;
                            // The DAO's mistake: pay out before zeroing the balance.
                            state.mut().paidOut += input.amount;
                            state.mut().balance -= input.amount;
                            state.mut().badOrderBalance = state.get().balance;
                            state.mut().inCall = 0;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "WithdrawGoodOrder",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 taken;",
                        body: `
                            if (state.get().balance < input.amount)
                            {
                                output.ok = 0;
                                return;
                            }
                            // Checks, effects, then interaction.
                            locals.taken = input.amount;
                            state.mut().balance -= locals.taken;
                            state.mut().paidOut += locals.taken;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 balance;\nuint64 paidOut;\nuint64 reentered;\nuint64 badOrderBalance;",
                        body: `
                            output.balance = state.get().balance;
                            output.paidOut = state.get().paidOut;
                            output.reentered = state.get().reentered;
                            output.badOrderBalance = state.get().badOrderBalance;
                        `,
                    },
                ],
                initialize: "state.mut().balance = 500;\nstate.mut().paidOut = 0;\nstate.mut().inCall = 0;\nstate.mut().reentered = 0;\nstate.mut().badOrderBalance = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(100), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(100), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(9999), invocator: 0, note: "over balance" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "TickDerivedRandomness",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/bad_randomness (theRun, Fomo3D)",
        stresses: "a winner picked from chain-visible data — the same predictability bug, and a determinism probe for the tick and digest host calls",
        caveat: "block.timestamp/blockhash become qpi.tick() and qpi.K12(); the script pins the tick, so a differing result is a compiler difference, not chain noise.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TickDerivedRandomness",
                header: {
                    archetype: "TickDerivedRandomness",
                    family: "vulnerabilities",
                    solidity: "bad randomness (SWC-120)",
                    stresses: "qpi.tick() and qpi.K12() feeding a winner selection",
                    caveat: "the tick is pinned by the script, so any difference is the compiler's",
                    axis: "base",
                },
                state: "uint64 lastTick;\nuint64 winner;\nid digestOfSeed;\nuint64 draws;",
                entries: [
                    {
                        name: "Draw",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 players;",
                        locals: "uint64 seed;\nid hashed;",
                        body: `
                            state.mut().lastTick = (uint64)qpi.tick();
                            locals.seed = state.get().lastTick + input.players;
                            locals.hashed = qpi.K12(locals.seed);
                            state.mut().digestOfSeed = locals.hashed;
                            if (input.players != 0)
                            {
                                state.mut().winner = QPI::mod(locals.seed, input.players);
                            }
                            state.mut().draws++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 lastTick;\nuint64 winner;\nuint64 draws;",
                        body: `
                            output.lastTick = state.get().lastTick;
                            output.winner = state.get().winner;
                            output.draws = state.get().draws;
                        `,
                    },
                ],
                initialize: "state.mut().lastTick = 0;\nstate.mut().winner = 0;\nstate.mut().draws = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(7), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 2 },
                    { kind: "procedure", entry: 1, in: u64(7), invocator: 0, note: "two ticks later — the seed moves" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 0, note: "zero players — QPI::mod by zero returns 0" },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    },

    {
        name: "UnboundedLoopBounded",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/denial_of_service (GovernMental, auction list)",
        stresses: "the payout loop that ran out of gas, ported to a statically bounded loop — the bound is the fix, and the residue is what happens to the entries past it",
        caveat: "QPI has no gas, and an unbounded loop is not expressible: every loop here is capacity-bounded, so the DoS becomes a truncation question.",
        axes: ["capacity", "loopShape"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "UnboundedLoopBounded",
                header: {
                    archetype: "UnboundedLoopBounded",
                    family: "vulnerabilities",
                    solidity: "denial of service by unbounded loop (SWC-113/128)",
                    stresses: "a bounded payout loop and the entries it cannot reach",
                    caveat: "no gas in QPI; the DoS becomes truncation past the capacity bound",
                    axis: `capacity=${capacity} loopShape=${axis.loopShape ?? "constant"}`,
                },
                state: `Array<uint64, ${capacity}> claims;\nuint64 paid;\nuint64 skipped;\nuint64 registered;`,
                entries: [
                    {
                        name: "Register",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;\nuint64 amount;",
                        locals: "uint64 i;\nuint64 bounded;",
                        body: `
                            locals.bounded = input.count;
                            if (locals.bounded > ${capacity})
                            {
                                state.mut().skipped += locals.bounded - ${capacity};
                                locals.bounded = ${capacity};
                            }
                            for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                            {
                                state.mut().claims.set(locals.i, input.amount);
                            }
                            state.mut().registered += locals.bounded;
                        `,
                    },
                    {
                        name: "PayAll",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 unused;",
                        locals: "uint64 i;\nuint64 total;",
                        body: `
                            locals.total = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.total += state.get().claims.get(locals.i);
                                state.mut().claims.set(locals.i, 0);
                            }
                            state.mut().paid += locals.total;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 paid;\nuint64 skipped;\nuint64 registered;",
                        body: `
                            output.paid = state.get().paid;
                            output.skipped = state.get().skipped;
                            output.registered = state.get().registered;
                        `,
                    },
                ],
                initialize: "state.mut().claims.setAll(0);\nstate.mut().paid = 0;\nstate.mut().skipped = 0;\nstate.mut().registered = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(2) + u64(10), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(0), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(capacity * 4) + u64(5), invocator: 0, note: "far past capacity" },
                    { kind: "procedure", entry: 2, in: u64(0), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "UninitialisedOwnerTakeover",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts (Parity multisig, 2017)",
        stresses: "an owner field never set at construction, so the first caller can claim it — the access-control hole behind the Parity freeze",
        caveat: "Solidity's uninitialised storage; here the field is deliberately left out of INITIALIZE, so its value is whatever construction leaves.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "UninitialisedOwnerTakeover",
                header: {
                    archetype: "UninitialisedOwnerTakeover",
                    family: "vulnerabilities",
                    solidity: "Parity multisig uninitialised owner (SWC-118)",
                    stresses: "a state field left out of INITIALIZE and then compared against",
                    caveat: "the port asserts whatever construction leaves the field as; both backends must agree on it",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "id owner;\nuint64 takeovers;\nuint64 vault;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Initialise",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 unused;",
                        output: "uint64 claimed;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().owner == NULL_ID)
                            {
                                state.mut().owner = qpi.invocator();
                                state.mut().takeovers++;
                                output.claimed = 1;
                                return;
                            }
                            output.claimed = 0;
                        `,
                    },
                    {
                        name: "Drain",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 scratch;",
                        body: `
                            if (qpi.invocator() != state.get().owner)
                            {
                                output.ok = 0;
                                return;
                            }
                            if (state.get().vault < input.amount)
                            {
                                output.ok = 0;
                                return;
                            }
                            state.mut().vault -= input.amount;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 takeovers;\nuint64 vault;",
                        body: "output.takeovers = state.get().takeovers;\noutput.vault = state.get().vault;",
                    },
                ],
                // `owner` is deliberately absent here — that absence is the archetype.
                initialize: "state.mut().takeovers = 0;\nstate.mut().vault = 900;",
            });
            return {
                source,
                script: script([
                    { kind: "function", entry: 1, note: "before any claim" },
                    { kind: "procedure", entry: 2, in: u64(10), invocator: 1, note: "drain before anyone owns it" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 1, note: "second caller claims the empty owner" },
                    { kind: "procedure", entry: 2, in: u64(10), invocator: 1, note: "and now drains" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 0, note: "too late for the first caller" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
