// The second batch of exploit shapes, from crytic/not-so-smart-contracts and the SWC registry.
//
// As in round 1, several originals are not expressible in QPI: there is no tx.origin phishing without an
// external call that re-enters, no selfdestruct, no delegatecall. Each is ported to the nearest legal
// shape and every emitted file says so in its header. The reason they are in a compiler corpus at all is
// that exploit code has a shape — a privilege read through the wrong name, an arithmetic guard that runs
// after the arithmetic — that hand-written probes do not naturally produce.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { identity, u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const HOLDERS = [identity(1), identity(2), identity(3)];

export const VULNERABILITY_CLASSIC_ARCHETYPES: Archetype[] = [
    {
        name: "ShadowedOwnerFieldPrivilege",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/variable_shadowing (SWC-119)",
        stresses:
            "two members named owner — one in a nested config struct, one in the contract state — with the privilege check reading whichever the name resolution picks",
        caveat: "Solidity's shadowing is between a base and a derived contract; QPI has no inheritance between contracts, so the port shadows across a nested struct instead. The privilege consequence is the same.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "ShadowedOwnerFieldPrivilege",
                header: {
                    archetype: "ShadowedOwnerFieldPrivilege",
                    family: "vulnerabilities",
                    solidity: "variable shadowing (SWC-119)",
                    stresses: "a privilege check against a shadowed owner field",
                    caveat: "base/derived shadowing becomes struct/state shadowing",
                    axis: "shadowed privilege",
                },
                prelude: "struct Config\n{\n    id owner;\n    uint64 limit;\n};",
                state: "Config config;\nid owner;\nuint64 privileged;\nuint64 refused;",
                entries: [
                    {
                        name: "Claim",
                        kind: "procedure",
                        number: 1,
                        locals: "id caller;",
                        body: `
                            locals.caller = qpi.invocator();
                            if (state.get().owner == NULL_ID)
                            {
                                state.mut().owner = locals.caller;
                            }
                            if (state.get().config.owner == NULL_ID)
                            {
                                state.mut().config.owner = locals.caller;
                            }
                        `,
                    },
                    {
                        name: "Privileged",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "id caller;",
                        body: `
                            locals.caller = qpi.invocator();
                            // The check reads the nested copy; the assignment above set both, so the two
                            // only diverge once one of them is reassigned.
                            if (!(state.get().config.owner == locals.caller))
                            {
                                state.mut().refused++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().privileged += input.amount;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Rotate",
                        kind: "procedure",
                        number: 3,
                        locals: "id caller;",
                        body: `
                            locals.caller = qpi.invocator();
                            state.mut().config.owner = locals.caller;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 privileged;\nuint64 refused;\nuint64 ownersAgree;",
                        body: `
                            output.privileged = state.get().privileged;
                            output.refused = state.get().refused;
                            output.ownersAgree = state.get().owner == state.get().config.owner ? 1 : 0;
                        `,
                    },
                ],
                initialize: "state.mut().privileged = 0;\nstate.mut().refused = 0;\nstate.mut().config.limit = 100;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, invocator: 0, note: "first claimant takes both owners" },
                    { kind: "procedure", entry: 2, in: u64(10), invocator: 0 },
                    { kind: "procedure", entry: 3, invocator: 1, note: "rotate only the shadowing copy" },
                    { kind: "procedure", entry: 2, in: u64(20), invocator: 0, note: "the real owner is now refused" },
                    { kind: "procedure", entry: 2, in: u64(30), invocator: 1, note: "the shadow owner is privileged" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "WrongInitializerNameTakeover",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/wrong_constructor_name (Rubixi, 2016)",
        stresses:
            "an ownership assignment sitting in an ordinary entry rather than in INITIALIZE — the Rubixi bug, where a misnamed constructor stayed callable",
        caveat: "QPI cannot misname INITIALIZE, so the port keeps a real INITIALIZE and adds the misnamed twin next to it; the finding is that both spellings compile to the same body and both must behave identically.",
        axes: ["placement"],
        build(axis) {
            const claimBody = `
                locals.caller = qpi.invocator();
                state.mut().owner = locals.caller;
                state.mut().claims++;
            `;
            const source = emitContract({
                axis,
                name: "WrongInitializerNameTakeover",
                header: {
                    archetype: "WrongInitializerNameTakeover",
                    family: "vulnerabilities",
                    solidity: "Rubixi wrong constructor name",
                    stresses: "an ownership assignment reachable from an entry",
                    caveat: "INITIALIZE cannot be misnamed in QPI; the misnamed twin is an ordinary entry",
                    axis: "constructor-shaped entry",
                },
                state: "id owner;\nuint64 claims;\nuint64 collected;",
                entries: [
                    { name: "DynamicPyramid", kind: "procedure", number: 1, locals: "id caller;", body: claimBody },
                    {
                        name: "Collect",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "id caller;",
                        body: `
                        locals.caller = qpi.invocator();
                        if (!(state.get().owner == locals.caller))
                        {
                            output.ok = 0;
                            return;
                        }
                        state.mut().collected += input.amount;
                        output.ok = 1;
                    `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 claims;\nuint64 collected;\nuint64 ownerIsSelf;",
                        body: `
                            output.claims = state.get().claims;
                            output.collected = state.get().collected;
                            output.ownerIsSelf = state.get().owner == SELF ? 1 : 0;
                        `,
                    },
                ],
                initialize: "state.mut().owner = SELF;\nstate.mut().claims = 0;\nstate.mut().collected = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 2, in: u64(5), invocator: 0, note: "not the owner yet" },
                    { kind: "procedure", entry: 1, invocator: 0, note: "the misnamed constructor takes ownership" },
                    { kind: "procedure", entry: 2, in: u64(5), invocator: 0 },
                    { kind: "procedure", entry: 1, invocator: 1, note: "and again, for the next caller" },
                    { kind: "procedure", entry: 2, in: u64(7), invocator: 0, note: "previous owner locked out" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "BiasedModuloSelection",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/bad_randomness (SWC-120)",
        stresses:
            "selecting a winner with a modulo of a hash — the bias when the modulus does not divide the range, computed both the biased and the rejection-sampled way",
        caveat: "The original draws from blockhash; QPI has no blockhash, so the port hashes a caller-supplied seed with K12 and takes the low word.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "BiasedModuloSelection",
                header: {
                    archetype: "BiasedModuloSelection",
                    family: "vulnerabilities",
                    solidity: "bad randomness (SWC-120)",
                    stresses: "modulo bias, and the rejection-sampled alternative, over the same draws",
                    caveat: "blockhash becomes K12 of a supplied seed",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> biasedCounts;\nArray<uint64, ${capacity}> fairCounts;\nuint64 draws;\nuint64 rejections;`,
                entries: [
                    {
                        name: "Draw",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "id hashed;\nuint64 word;\nuint64 biased;\nuint64 fair;\nuint64 guard;\nuint64 limit;",
                        body: `
                            locals.word = input.seed;
                            locals.hashed = qpi.K12(locals.word);
                            locals.word = locals.hashed.u64._0;
                            locals.biased = QPI::mod(locals.word, (uint64)${capacity});
                            state.mut().biasedCounts.set(locals.biased, state.get().biasedCounts.get(locals.biased) + 1);
                            // Rejection sampling: redraw while the value sits in the short tail.
                            locals.limit = QPI::div(18446744073709551615ULL, (uint64)${capacity}) * (uint64)${capacity};
                            locals.guard = 0;
                            while (locals.word >= locals.limit && locals.guard < 8)
                            {
                                locals.hashed = qpi.K12(locals.word);
                                locals.word = locals.hashed.u64._0;
                                state.mut().rejections++;
                                locals.guard++;
                            }
                            locals.fair = QPI::mod(locals.word, (uint64)${capacity});
                            state.mut().fairCounts.set(locals.fair, state.get().fairCounts.get(locals.fair) + 1);
                            state.mut().draws++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 draws;\nuint64 rejections;\nuint64 biasedZero;\nuint64 fairZero;",
                        body: `
                            output.draws = state.get().draws;
                            output.rejections = state.get().rejections;
                            output.biasedZero = state.get().biasedCounts.get(0);
                            output.fairZero = state.get().fairCounts.get(0);
                        `,
                    },
                ],
                initialize: "state.mut().biasedCounts.setAll(0);\nstate.mut().fairCounts.setAll(0);\nstate.mut().draws = 0;\nstate.mut().rejections = 0;",
            });
            const steps: CallStep[] = [];
            for (const seed of [0n, 1n, 2n, 3n, 17n, 18446744073709551615n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(seed), invocator: 0, note: `seed ${seed}` });
            }
            steps.push({ kind: "function", entry: 1 });
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "HoneypotUnreachableBranch",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/honeypots/varloop",
        stresses:
            "a payout branch guarded by a condition that can never hold — dead code the optimiser is free to delete, next to a live branch that must survive",
        caveat: "The original honeypot hides the unreachability behind a shadowed variable; the port makes it arithmetic, which is what the optimiser actually reasons about.",
        axes: ["placement", "constSource"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HoneypotUnreachableBranch",
                header: {
                    archetype: "HoneypotUnreachableBranch",
                    family: "vulnerabilities",
                    solidity: "varloop honeypot",
                    stresses: "provably dead code next to live code",
                    caveat: "unreachability is arithmetic rather than shadowing",
                    axis: "dead branch",
                },
                state: "uint64 paid;\nuint64 refused;\nuint64 deadBranchTaken;\nuint64 calls;",
                entries: [
                    {
                        name: "Withdraw",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 doubled;\nuint64 halved;",
                        body: `
                            state.mut().calls++;
                            locals.doubled = input.amount * 2;
                            locals.halved = QPI::div(locals.doubled, 2ULL);
                            // Unreachable for every even doubled value, which is all of them.
                            if (QPI::mod(locals.doubled, 2ULL) == 1)
                            {
                                state.mut().deadBranchTaken++;
                                state.mut().paid += input.amount;
                                output.ok = 1;
                                return;
                            }
                            if (locals.halved == input.amount && input.amount < 9223372036854775808ULL)
                            {
                                state.mut().paid += QPI::div(input.amount, 2ULL);
                                output.ok = 1;
                                return;
                            }
                            state.mut().refused++;
                            output.ok = 0;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 paid;\nuint64 refused;\nuint64 deadBranchTaken;\nuint64 calls;",
                        body: `
                            output.paid = state.get().paid;
                            output.refused = state.get().refused;
                            output.deadBranchTaken = state.get().deadBranchTaken;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().paid = 0;\nstate.mut().refused = 0;\nstate.mut().deadBranchTaken = 0;\nstate.mut().calls = 0;",
            });
            const steps: CallStep[] = [];
            for (const amount of [0n, 1n, 100n, 9223372036854775807n, 9223372036854775808n, 18446744073709551615n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount), invocator: 0, note: `amount ${amount}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "UncheckedSubtractUnderflowLedger",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/integer_overflow (SWC-101)",
        stresses:
            "a balance decremented without a prior check — the subtraction that wraps to a near-maximal balance, recorded next to the checked spelling of the same operation",
        caveat: "The original relies on Solidity 0.7 wrapping semantics; QPI wraps too, so this port is faithful apart from the width.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "UncheckedSubtractUnderflowLedger",
                header: {
                    archetype: "UncheckedSubtractUnderflowLedger",
                    family: "vulnerabilities",
                    solidity: "integer underflow in a ledger (SWC-101)",
                    stresses: "unchecked versus checked balance decrement, side by side",
                    caveat: "uint256 becomes uint64; the wrap boundary moves but the shape does not",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<id, uint64, ${capacity}> unchecked;\nHashMap<id, uint64, ${capacity}> checked;\nuint64 underflows;\nuint64 refusals;`,
                entries: [
                    {
                        name: "Credit",
                        kind: "procedure",
                        number: 1,
                        input: "id who;\nuint64 amount;",
                        locals: "uint64 balance;",
                        body: `
                            locals.balance = 0;
                            state.get().unchecked.get(input.who, locals.balance);
                            state.mut().unchecked.set(input.who, locals.balance + input.amount);
                            locals.balance = 0;
                            state.get().checked.get(input.who, locals.balance);
                            state.mut().checked.set(input.who, locals.balance + input.amount);
                        `,
                    },
                    {
                        name: "Debit",
                        kind: "procedure",
                        number: 2,
                        input: "id who;\nuint64 amount;",
                        locals: "uint64 balance;\nuint64 after;",
                        body: `
                            locals.balance = 0;
                            state.get().unchecked.get(input.who, locals.balance);
                            locals.after = locals.balance - input.amount;
                            if (locals.after > locals.balance)
                            {
                                state.mut().underflows++;
                            }
                            state.mut().unchecked.set(input.who, locals.after);

                            locals.balance = 0;
                            state.get().checked.get(input.who, locals.balance);
                            if (locals.balance < input.amount)
                            {
                                state.mut().refusals++;
                                return;
                            }
                            state.mut().checked.set(input.who, locals.balance - input.amount);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "id who;",
                        output: "uint64 uncheckedBalance;\nuint64 checkedBalance;\nuint64 underflows;\nuint64 refusals;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            state.get().unchecked.get(input.who, locals.fetched);
                            output.uncheckedBalance = locals.fetched;
                            locals.fetched = 0;
                            state.get().checked.get(input.who, locals.fetched);
                            output.checkedBalance = locals.fetched;
                            output.underflows = state.get().underflows;
                            output.refusals = state.get().refusals;
                        `,
                    },
                ],
                initialize: "state.mut().unchecked.reset();\nstate.mut().checked.reset();\nstate.mut().underflows = 0;\nstate.mut().refusals = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: HOLDERS[0] + u64(100), invocator: 0 },
                    { kind: "procedure", entry: 2, in: HOLDERS[0] + u64(40), invocator: 0 },
                    { kind: "function", entry: 1, in: HOLDERS[0] },
                    { kind: "procedure", entry: 2, in: HOLDERS[0] + u64(100), invocator: 0, note: "underflow in the unchecked table" },
                    { kind: "function", entry: 1, in: HOLDERS[0] },
                    { kind: "procedure", entry: 2, in: HOLDERS[1] + u64(1), invocator: 0, note: "debit an absent key" },
                    { kind: "function", entry: 1, in: HOLDERS[1] },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "OriginatorVersusInvocatorAuth",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/incorrect_interface / tx.origin auth (SWC-115)",
        stresses:
            "an authorisation check written against the originator instead of the immediate caller — the tx.origin bug, which QPI reproduces exactly because it exposes both",
        caveat: "This is one of the few classics that ports faithfully: qpi.originator() and qpi.invocator() are the same distinction as tx.origin and msg.sender.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "OriginatorVersusInvocatorAuth",
                header: {
                    archetype: "OriginatorVersusInvocatorAuth",
                    family: "vulnerabilities",
                    solidity: "tx.origin authorisation (SWC-115)",
                    stresses: "the same guard written against the originator and against the invocator",
                    caveat: "faithful port — QPI exposes both identities",
                    axis: "origin vs sender",
                },
                state: "id owner;\nuint64 originatorPasses;\nuint64 invocatorPasses;\nuint64 disagreements;\nuint64 moved;",
                entries: [
                    {
                        name: "Transfer",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 byOriginator;\nuint64 byInvocator;",
                        body: `
                            locals.byOriginator = state.get().owner == qpi.originator() ? 1 : 0;
                            locals.byInvocator = state.get().owner == qpi.invocator() ? 1 : 0;
                            if (locals.byOriginator != locals.byInvocator)
                            {
                                state.mut().disagreements++;
                            }
                            state.mut().originatorPasses += locals.byOriginator;
                            state.mut().invocatorPasses += locals.byInvocator;
                            if (locals.byOriginator == 0)
                            {
                                output.ok = 0;
                                return;
                            }
                            state.mut().moved += input.amount;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Adopt",
                        kind: "procedure",
                        number: 2,
                        locals: "id scratch;",
                        body: "state.mut().owner = qpi.invocator();",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 originatorPasses;\nuint64 invocatorPasses;\nuint64 disagreements;\nuint64 moved;",
                        body: `
                            output.originatorPasses = state.get().originatorPasses;
                            output.invocatorPasses = state.get().invocatorPasses;
                            output.disagreements = state.get().disagreements;
                            output.moved = state.get().moved;
                        `,
                    },
                ],
                initialize:
                    "state.mut().owner = NULL_ID;\nstate.mut().originatorPasses = 0;\nstate.mut().invocatorPasses = 0;\nstate.mut().disagreements = 0;\nstate.mut().moved = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(10), invocator: 0, note: "no owner yet" },
                    { kind: "procedure", entry: 2, invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(10), invocator: 0, note: "owner calls directly" },
                    { kind: "procedure", entry: 1, in: u64(10), invocator: 1, note: "a different caller" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "TickScheduledPayout",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/timestamp_dependence (SWC-116)",
        stresses:
            "a payout schedule keyed on the tick number — arithmetic on a host-supplied counter, evaluated inside a hook and inside an entry so both paths see the same tick",
        caveat: "block.timestamp becomes qpi.tick(); the manipulability argument does not carry over, but the arithmetic-on-host-state shape does.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "TickScheduledPayout",
                header: {
                    archetype: "TickScheduledPayout",
                    family: "vulnerabilities",
                    solidity: "timestamp dependence (SWC-116)",
                    stresses: "a schedule computed from the tick counter in two different places",
                    caveat: "block.timestamp becomes qpi.tick()",
                    axis: "tick-scheduled payout",
                },
                state: "uint64 windowsOpened;\nuint64 paidInWindow;\nuint64 refusedOutsideWindow;\nuint64 lastWindow;",
                entries: [
                    {
                        name: "Claim",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 tick;\nuint64 window;",
                        body: `
                            locals.tick = (uint64)qpi.tick();
                            locals.window = QPI::mod(locals.tick, 4ULL);
                            if (locals.window != 0)
                            {
                                state.mut().refusedOutsideWindow++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().paidInWindow += input.amount;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 windowsOpened;\nuint64 paidInWindow;\nuint64 refusedOutsideWindow;\nuint64 lastWindow;",
                        body: `
                            output.windowsOpened = state.get().windowsOpened;
                            output.paidInWindow = state.get().paidInWindow;
                            output.refusedOutsideWindow = state.get().refusedOutsideWindow;
                            output.lastWindow = state.get().lastWindow;
                        `,
                    },
                ],
                initialize: "state.mut().windowsOpened = 0;\nstate.mut().paidInWindow = 0;\nstate.mut().refusedOutsideWindow = 0;\nstate.mut().lastWindow = 0;",
                beginTick: `
                    state.mut().lastWindow = QPI::mod((uint64)qpi.tick(), 4ULL);
                    if (state.get().lastWindow == 0)
                    {
                        state.mut().windowsOpened++;
                    }
                `,
            });
            const steps: CallStep[] = [];
            for (let i = 0; i < 6; i++) {
                steps.push({ kind: "procedure", entry: 1, in: u64(10), invocator: 0, note: `claim at tick offset ${i}` });
                steps.push({ kind: "function", entry: 1 });
                steps.push({ kind: "advanceTick", n: 1 });
            }
            return { source, script: script(steps) };
        },
    },

    {
        name: "SignedFeeDivisionTowardZero",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/rounding (fee splitting)",
        stresses:
            "a fee split over signed amounts — C++ division truncates toward zero, so a negative adjustment rounds the other way from the positive one and the remainders do not net out",
        caveat: "Solidity's int division also truncates toward zero, so the arithmetic is faithful; what changes is the width.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "SignedFeeDivisionTowardZero",
                header: {
                    archetype: "SignedFeeDivisionTowardZero",
                    family: "vulnerabilities",
                    solidity: "fee split rounding",
                    stresses: "truncation toward zero across the sign boundary, with the remainder tracked",
                    caveat: "faithful apart from the width",
                    axis: "signed fee rounding",
                },
                state: "sint64 treasury;\nsint64 counterparty;\nsint64 dust;\nuint64 settlements;",
                entries: [
                    {
                        name: "Settle",
                        kind: "procedure",
                        number: 1,
                        input: "sint64 amount;\nsint64 feeBasisPoints;",
                        locals: "sint64 fee;\nsint64 remainder;",
                        body: `
                            locals.fee = QPI::div(input.amount * input.feeBasisPoints, (sint64)10000);
                            locals.remainder = QPI::mod(input.amount * input.feeBasisPoints, (sint64)10000);
                            state.mut().treasury += locals.fee;
                            state.mut().counterparty += input.amount - locals.fee;
                            state.mut().dust += locals.remainder;
                            state.mut().settlements++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 treasury;\nsint64 counterparty;\nsint64 dust;\nuint64 settlements;",
                        body: `
                            output.treasury = state.get().treasury;
                            output.counterparty = state.get().counterparty;
                            output.dust = state.get().dust;
                            output.settlements = state.get().settlements;
                        `,
                    },
                ],
                initialize: "state.mut().treasury = 0;\nstate.mut().counterparty = 0;\nstate.mut().dust = 0;\nstate.mut().settlements = 0;",
            });
            const steps: CallStep[] = [];
            for (const [amount, fee] of [
                [1n, 250n],
                [-1n, 250n],
                [12345n, 250n],
                [-12345n, 250n],
                [12345n, -250n],
                [0n, 250n],
                [-9223372036854775808n, 1n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount) + u64(fee), invocator: 0, note: `${amount} at ${fee}bp` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },
];
