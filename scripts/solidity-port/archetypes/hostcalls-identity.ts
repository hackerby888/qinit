// The host interface: identity, money and the node's own view of the world.
//
// This family has no Solidity originals to port — `qpi.arbitrator()`, `qpi.computor(i)`,
// `qpi.nextId()` and `qpi.getEntity()` have no Ethereum analogue, and the ones that do (`msg.sender`,
// `address(this).balance`, `selfdestruct`) map onto a different model. What each archetype records is
// the Solidity pattern it stands in for, and the value is that these are *host calls*: the two backends
// each lower them to the same lhost import, and every result the contract stores is a place where a
// wrong argument order, a missed sign extension or a dropped return value becomes a digest difference.
//
// Every host answer is mirrored into contract state, because the digest covers contract state only.

import { emitContract } from "../emit";
import { script } from "./common";
import { identity, u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";
const ACTORS = [identity(1), identity(2)];

/** Drive one uint64-input procedure over a ladder and read after each. */
function ladder(values: bigint[], entry = 1): CallStep[] {
    const steps: CallStep[] = [];
    for (const value of values) {
        steps.push({ kind: "procedure", entry, in: u64(value), invocator: 0, note: `n=${value}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const HOSTCALL_IDENTITY_ARCHETYPES: Archetype[] = [
    {
        name: "HostNextAndPrevId",
        family: "hostcalls",
        solidity: `${SOL}/various/address_code.sol`,
        stresses:
            "qpi.nextId and qpi.prevId walked in both directions from several starting points — a 32-byte value in and a 32-byte value out, which is where an id passed by the wrong reference would show",
        caveat: "No Solidity analogue: Ethereum has no successor relation on addresses.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostNextAndPrevId",
                header: {
                    archetype: "HostNextAndPrevId",
                    family: "hostcalls",
                    solidity: "no Solidity analogue",
                    stresses: "nextId/prevId round trips and their fixed points",
                    caveat: "Ethereum addresses have no ordering host call",
                    axis: "id walk",
                },
                state: "id cursor;\nuint64 steps;\nuint64 roundTrips;\nuint64 fixedPoints;",
                entries: [
                    {
                        name: "Walk",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nid forward;\nid back;",
                        body: `
                            locals.forward = state.get().cursor;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.back = locals.forward;
                                locals.forward = qpi.nextId(locals.forward);
                                if (locals.forward == locals.back)
                                {
                                    state.mut().fixedPoints++;
                                }
                                state.mut().steps++;
                            }
                            // Walking back the same number of steps must return the starting point.
                            locals.back = locals.forward;
                            for (locals.i = 0; locals.i < input.count; locals.i++)
                            {
                                locals.back = qpi.prevId(locals.back);
                            }
                            if (locals.back == state.get().cursor)
                            {
                                state.mut().roundTrips++;
                            }
                            state.mut().cursor = locals.forward;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 steps;\nuint64 roundTrips;\nuint64 fixedPoints;\nuint64 cursorIsSelf;",
                        body: `
                            output.steps = state.get().steps;
                            output.roundTrips = state.get().roundTrips;
                            output.fixedPoints = state.get().fixedPoints;
                            output.cursorIsSelf = state.get().cursor == SELF ? 1 : 0;
                        `,
                    },
                ],
                initialize: "state.mut().cursor = SELF;\nstate.mut().steps = 0;\nstate.mut().roundTrips = 0;\nstate.mut().fixedPoints = 0;",
            });
            return { source, script: script(ladder([0n, 1n, 3n])) };
        },
    },

    {
        name: "HostIsContractIdLadder",
        family: "hostcalls",
        solidity: `${SOL}/various/address_code.sol (extcodesize check)`,
        stresses: "qpi.isContractId over SELF, a user identity, NULL_ID and a derived id — the contract-or-user test every access guard is built on",
        caveat: "Solidity's equivalent is `extcodesize(a) > 0`, which is a storage read; QPI's is a range test on the identity itself.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostIsContractIdLadder",
                header: {
                    archetype: "HostIsContractIdLadder",
                    family: "hostcalls",
                    solidity: `${SOL}/various/address_code.sol`,
                    stresses: "isContractId across four kinds of identity",
                    caveat: "extcodesize becomes a range test",
                    axis: "contract-or-user",
                },
                state: "uint64 selfIsContract;\nuint64 nullIsContract;\nuint64 callerIsContract;\nuint64 derivedIsContract;\nuint64 calls;",
                entries: [
                    {
                        name: "Probe",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "id derived;",
                        body: `
                            locals.derived = qpi.K12(input.seed);
                            state.mut().selfIsContract = qpi.isContractId(SELF) ? 1 : 0;
                            state.mut().nullIsContract = qpi.isContractId(NULL_ID) ? 1 : 0;
                            state.mut().callerIsContract = qpi.isContractId(qpi.invocator()) ? 1 : 0;
                            state.mut().derivedIsContract = qpi.isContractId(locals.derived) ? 1 : 0;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 selfIsContract;\nuint64 nullIsContract;\nuint64 callerIsContract;\nuint64 derivedIsContract;\nuint64 calls;",
                        body: `
                            output.selfIsContract = state.get().selfIsContract;
                            output.nullIsContract = state.get().nullIsContract;
                            output.callerIsContract = state.get().callerIsContract;
                            output.derivedIsContract = state.get().derivedIsContract;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize:
                    "state.mut().selfIsContract = 0;\nstate.mut().nullIsContract = 0;\nstate.mut().callerIsContract = 0;\nstate.mut().derivedIsContract = 0;\nstate.mut().calls = 0;",
            });
            return { source, script: script(ladder([0n, 1n, 18446744073709551615n])) };
        },
    },

    {
        name: "HostComputorIndexRange",
        family: "hostcalls",
        solidity: "no Solidity analogue (validator set)",
        stresses:
            "qpi.computor(i) across the committee index range — a uint16 argument whose answer is a 32-byte identity the contract stores, so a dropped or truncated out-parameter is visible in the digest",
        caveat: "Ethereum contracts cannot read the validator set at all. Indices past 675 are deliberately not driven: the simulator generates a committee per instance and its override is keyed by the raw index, so an out-of-range read wraps onto an unpinned entry and is not reproducible even between two runs of the same backend (F208).",
        axes: ["placement", "loopShape"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostComputorIndexRange",
                header: {
                    archetype: "HostComputorIndexRange",
                    family: "hostcalls",
                    solidity: "no Solidity analogue",
                    stresses: "computor(i) at 0, 1, 337 and 675",
                    caveat: "out-of-range indices excluded — the simulator cannot pin them (F208)",
                    axis: "computor index range",
                },
                state: "uint64 distinct;\nuint64 nullResults;\nid lastComputor;\nid firstComputor;\nuint64 probes;",
                entries: [
                    {
                        name: "Probe",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;",
                        locals: "id fetched;",
                        body: `
                            locals.fetched = qpi.computor((uint16)input.index);
                            if (locals.fetched == NULL_ID)
                            {
                                state.mut().nullResults++;
                            }
                            if (!(locals.fetched == state.get().lastComputor))
                            {
                                state.mut().distinct++;
                            }
                            if (state.get().probes == 0)
                            {
                                state.mut().firstComputor = locals.fetched;
                            }
                            state.mut().lastComputor = locals.fetched;
                            state.mut().probes++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 distinct;\nuint64 nullResults;\nuint64 probes;\nuint64 firstIsLast;",
                        body: `
                            output.distinct = state.get().distinct;
                            output.nullResults = state.get().nullResults;
                            output.probes = state.get().probes;
                            output.firstIsLast = state.get().firstComputor == state.get().lastComputor ? 1 : 0;
                        `,
                    },
                ],
                initialize:
                    "state.mut().distinct = 0;\nstate.mut().nullResults = 0;\nstate.mut().lastComputor = NULL_ID;\nstate.mut().firstComputor = NULL_ID;\nstate.mut().probes = 0;",
            });
            return { source, script: script(ladder([0n, 1n, 337n, 675n])) };
        },
    },

    {
        name: "HostEntityRecordFields",
        family: "hostcalls",
        solidity: `${SOL}/various/balance.sol`,
        stresses:
            "qpi.getEntity filling an Entity struct out-parameter — a 60-byte record the host writes into contract memory, where a field offset off by one shows up as a nonsense balance",
        caveat: "Solidity's `address.balance` is one word; the Entity record carries incoming and outgoing totals and four counters, so the port reads all of them.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostEntityRecordFields",
                header: {
                    archetype: "HostEntityRecordFields",
                    family: "hostcalls",
                    solidity: `${SOL}/various/balance.sol`,
                    stresses: "every field of the Entity record the host fills in",
                    caveat: "address.balance becomes a multi-field record",
                    axis: "entity record",
                },
                state: "sint64 incoming;\nsint64 outgoing;\nuint64 inTransfers;\nuint64 outTransfers;\nuint64 found;\nuint64 missing;",
                entries: [
                    {
                        name: "Look",
                        kind: "procedure",
                        number: 1,
                        input: "id who;",
                        locals: "Entity record;\nbit ok;",
                        body: `
                            locals.ok = qpi.getEntity(input.who, locals.record);
                            if (locals.ok)
                            {
                                state.mut().found++;
                                state.mut().incoming = locals.record.incomingAmount;
                                state.mut().outgoing = locals.record.outgoingAmount;
                                state.mut().inTransfers = (uint64)locals.record.numberOfIncomingTransfers;
                                state.mut().outTransfers = (uint64)locals.record.numberOfOutgoingTransfers;
                            }
                            else
                            {
                                state.mut().missing++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 incoming;\nsint64 outgoing;\nuint64 inTransfers;\nuint64 outTransfers;\nuint64 found;\nuint64 missing;",
                        body: `
                            output.incoming = state.get().incoming;
                            output.outgoing = state.get().outgoing;
                            output.inTransfers = state.get().inTransfers;
                            output.outTransfers = state.get().outTransfers;
                            output.found = state.get().found;
                            output.missing = state.get().missing;
                        `,
                    },
                ],
                initialize:
                    "state.mut().incoming = 0;\nstate.mut().outgoing = 0;\nstate.mut().inTransfers = 0;\nstate.mut().outTransfers = 0;\nstate.mut().found = 0;\nstate.mut().missing = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: ACTORS[0], invocator: 0, note: "a funded identity" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: "00".repeat(32), invocator: 0, note: "NULL_ID" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: identity(9), invocator: 0, note: "an identity with no record" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "HostTransferAndReward",
        family: "hostcalls",
        solidity: `${SOL}/various/send_ether.sol`,
        stresses:
            "qpi.transfer at the amount boundaries against the invocation reward the call arrived with — the remaining-balance code the host returns is what the contract stores",
        caveat: "Solidity's `.send` returns a bool and its `.transfer` reverts; QPI returns the remaining amount, negative when short, so the port records the code instead of branching on success.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostTransferAndReward",
                header: {
                    archetype: "HostTransferAndReward",
                    family: "hostcalls",
                    solidity: `${SOL}/various/send_ether.sol`,
                    stresses: "transfer return codes and the reward that funded them",
                    caveat: "no revert on a failed transfer — a negative return instead",
                    axis: "transfer codes",
                },
                state: "sint64 lastResult;\nsint64 rewardTotal;\nuint64 successes;\nuint64 failures;",
                entries: [
                    {
                        name: "Pay",
                        kind: "procedure",
                        number: 1,
                        input: "id target;\nsint64 amount;",
                        output: "sint64 result;",
                        locals: "sint64 result;",
                        body: `
                            state.mut().rewardTotal += qpi.invocationReward();
                            locals.result = qpi.transfer(input.target, input.amount);
                            state.mut().lastResult = locals.result;
                            if (locals.result < 0)
                            {
                                state.mut().failures++;
                            }
                            else
                            {
                                state.mut().successes++;
                            }
                            output.result = locals.result;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 lastResult;\nsint64 rewardTotal;\nuint64 successes;\nuint64 failures;",
                        body: `
                            output.lastResult = state.get().lastResult;
                            output.rewardTotal = state.get().rewardTotal;
                            output.successes = state.get().successes;
                            output.failures = state.get().failures;
                        `,
                    },
                ],
                initialize: "state.mut().lastResult = 0;\nstate.mut().rewardTotal = 0;\nstate.mut().successes = 0;\nstate.mut().failures = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: ACTORS[0] + u64(0), invocator: 0, amount: "1000", note: "zero transfer, funded call" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: ACTORS[0] + u64(500), invocator: 0, amount: "1000", note: "within the balance" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: ACTORS[0] + u64(1000000000000000n), invocator: 0, note: "past the balance" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: "00".repeat(32) + u64(1), invocator: 0, amount: "10", note: "to NULL_ID — destroys the amount" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "HostBurnLadder",
        family: "hostcalls",
        solidity: `${SOL}/various/selfdestruct.sol`,
        stresses:
            "qpi.burn across zero, a small amount, the balance and past it — the closest QPI has to destroying value, with a signed amount and a signed return",
        caveat: "selfdestruct sends the balance somewhere; burn destroys it and the contract keeps running, so only the value-destruction half carries over.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostBurnLadder",
                header: {
                    archetype: "HostBurnLadder",
                    family: "hostcalls",
                    solidity: `${SOL}/various/selfdestruct.sol`,
                    stresses: "burn at four amounts and the codes it returns",
                    caveat: "selfdestruct becomes burn; the contract survives",
                    axis: "burn ladder",
                },
                state: "sint64 lastResult;\nsint64 burnedTotal;\nuint64 refusals;\nsint64 rewardTotal;",
                entries: [
                    {
                        name: "Burn",
                        kind: "procedure",
                        number: 1,
                        input: "sint64 amount;",
                        output: "sint64 result;",
                        locals: "sint64 result;",
                        body: `
                            state.mut().rewardTotal += qpi.invocationReward();
                            locals.result = qpi.burn(input.amount);
                            state.mut().lastResult = locals.result;
                            if (locals.result < 0)
                            {
                                state.mut().refusals++;
                            }
                            else
                            {
                                state.mut().burnedTotal += input.amount;
                            }
                            output.result = locals.result;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 lastResult;\nsint64 burnedTotal;\nuint64 refusals;\nsint64 rewardTotal;",
                        body: `
                            output.lastResult = state.get().lastResult;
                            output.burnedTotal = state.get().burnedTotal;
                            output.refusals = state.get().refusals;
                            output.rewardTotal = state.get().rewardTotal;
                        `,
                    },
                ],
                initialize: "state.mut().lastResult = 0;\nstate.mut().burnedTotal = 0;\nstate.mut().refusals = 0;\nstate.mut().rewardTotal = 0;",
            });
            const steps: CallStep[] = [];
            for (const [amount, reward] of [
                [0n, "100"],
                [50n, "100"],
                [1000000n, "0"],
                [-1n, "0"],
            ] as [bigint, string][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount), invocator: 0, amount: reward, note: `burn ${amount}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "HostSignatureValidity",
        family: "hostcalls",
        solidity: `${SOL}/various/ecrecover.sol`,
        stresses:
            "qpi.signatureValidity with a 64-byte signature array built in state — a large by-reference argument, over a digest the contract computes itself",
        caveat: "ecrecover returns the signer; QPI's call returns only valid/invalid against a given entity, so the port checks the answer rather than recovering.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostSignatureValidity",
                header: {
                    archetype: "HostSignatureValidity",
                    family: "hostcalls",
                    solidity: `${SOL}/various/ecrecover.sol`,
                    stresses: "a 64-byte signature argument and the digest it is checked against",
                    caveat: "no signer recovery — a yes/no answer",
                    axis: "signature check",
                },
                state: "uint64 valid;\nuint64 invalid;\nuint64 checks;\nid lastDigest;",
                entries: [
                    {
                        name: "Check",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 seed;",
                        locals: "Array<sint8, 64> signature;\nid digest;\nuint64 i;\nbit ok;",
                        body: `
                            locals.digest = qpi.K12(input.seed);
                            for (locals.i = 0; locals.i < 64; locals.i++)
                            {
                                locals.signature.set(locals.i, (sint8)(input.seed + locals.i));
                            }
                            locals.ok = qpi.signatureValidity(qpi.invocator(), locals.digest, locals.signature);
                            if (locals.ok)
                            {
                                state.mut().valid++;
                            }
                            else
                            {
                                state.mut().invalid++;
                            }
                            state.mut().lastDigest = locals.digest;
                            state.mut().checks++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 valid;\nuint64 invalid;\nuint64 checks;",
                        body: "output.valid = state.get().valid;\noutput.invalid = state.get().invalid;\noutput.checks = state.get().checks;",
                    },
                ],
                initialize: "state.mut().valid = 0;\nstate.mut().invalid = 0;\nstate.mut().checks = 0;\nstate.mut().lastDigest = NULL_ID;",
            });
            return { source, script: script(ladder([0n, 1n, 255n])) };
        },
    },

    {
        name: "HostDividendDistribution",
        family: "hostcalls",
        solidity: "openzeppelin-contracts/contracts/finance/PaymentSplitter.sol",
        stresses:
            "qpi.distributeDividends, whose per-share amount the host multiplies by 676 — an implicit scaling both backends have to apply to the same argument",
        caveat: "PaymentSplitter divides a balance among registered payees; the QPI call pays every shareholder of the contract's own shares, so the port compares only the accept/refuse answer and the balance it leaves.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostDividendDistribution",
                header: {
                    archetype: "HostDividendDistribution",
                    family: "hostcalls",
                    solidity: "PaymentSplitter",
                    stresses: "distributeDividends accept/refuse across amounts",
                    caveat: "the payee set is the shareholder set, not a registered list",
                    axis: "dividends",
                },
                state: "uint64 accepted;\nuint64 refused;\nsint64 lastAmount;\nsint64 rewardTotal;",
                entries: [
                    {
                        name: "Pay",
                        kind: "procedure",
                        number: 1,
                        input: "sint64 amountPerShare;",
                        output: "uint64 ok;",
                        locals: "bit ok;",
                        body: `
                            state.mut().rewardTotal += qpi.invocationReward();
                            locals.ok = qpi.distributeDividends(input.amountPerShare);
                            state.mut().lastAmount = input.amountPerShare;
                            if (locals.ok)
                            {
                                state.mut().accepted++;
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
                        output: "uint64 accepted;\nuint64 refused;\nsint64 lastAmount;\nsint64 rewardTotal;",
                        body: `
                            output.accepted = state.get().accepted;
                            output.refused = state.get().refused;
                            output.lastAmount = state.get().lastAmount;
                            output.rewardTotal = state.get().rewardTotal;
                        `,
                    },
                ],
                initialize: "state.mut().accepted = 0;\nstate.mut().refused = 0;\nstate.mut().lastAmount = 0;\nstate.mut().rewardTotal = 0;",
            });
            const steps: CallStep[] = [];
            for (const [amount, reward] of [
                [0n, "0"],
                [1n, "1000000"],
                [1000000n, "0"],
                [-5n, "0"],
            ] as [bigint, string][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount), invocator: 0, amount: reward, note: `per share ${amount}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "HostSelfAndInvocatorRelations",
        family: "hostcalls",
        solidity: `${SOL}/various/msg_sender.sol`,
        stresses:
            "SELF, SELF_INDEX, invocator and originator compared against each other in one procedure — the four identities every access guard is written from",
        caveat: "Solidity has msg.sender and tx.origin; QPI adds SELF and the contract's own index, so two of the four have no original.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostSelfAndInvocatorRelations",
                header: {
                    archetype: "HostSelfAndInvocatorRelations",
                    family: "hostcalls",
                    solidity: `${SOL}/various/msg_sender.sol`,
                    stresses: "the relations between SELF, SELF_INDEX, invocator and originator",
                    caveat: "SELF and SELF_INDEX have no Solidity equivalent",
                    axis: "identity relations",
                },
                state: "uint64 selfIndex;\nuint64 invocatorIsOriginator;\nuint64 invocatorIsSelf;\nuint64 calls;\nid lastInvocator;",
                entries: [
                    {
                        name: "Observe",
                        kind: "procedure",
                        number: 1,
                        locals: "id caller;\nid origin;",
                        body: `
                            locals.caller = qpi.invocator();
                            locals.origin = qpi.originator();
                            state.mut().selfIndex = (uint64)SELF_INDEX;
                            state.mut().invocatorIsOriginator += locals.caller == locals.origin ? 1 : 0;
                            state.mut().invocatorIsSelf += locals.caller == SELF ? 1 : 0;
                            state.mut().lastInvocator = locals.caller;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 selfIndex;\nuint64 invocatorIsOriginator;\nuint64 invocatorIsSelf;\nuint64 calls;\nuint64 lastIsNull;",
                        body: `
                            output.selfIndex = state.get().selfIndex;
                            output.invocatorIsOriginator = state.get().invocatorIsOriginator;
                            output.invocatorIsSelf = state.get().invocatorIsSelf;
                            output.calls = state.get().calls;
                            output.lastIsNull = state.get().lastInvocator == NULL_ID ? 1 : 0;
                        `,
                    },
                ],
                initialize:
                    "state.mut().selfIndex = 0;\nstate.mut().invocatorIsOriginator = 0;\nstate.mut().invocatorIsSelf = 0;\nstate.mut().calls = 0;\nstate.mut().lastInvocator = NULL_ID;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, invocator: 0 },
                    { kind: "procedure", entry: 1, invocator: 1 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                    { kind: "procedure", entry: 1, invocator: 0 },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    },

    {
        name: "HostArbitratorConstant",
        family: "hostcalls",
        solidity: "no Solidity analogue (protocol constant)",
        stresses: "qpi.arbitrator() read from an entry and from a tick hook, compared against itself across ticks — a host constant that must not move",
        caveat: "Ethereum has no protocol-level arbitrator identity.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "HostArbitratorConstant",
                header: {
                    archetype: "HostArbitratorConstant",
                    family: "hostcalls",
                    solidity: "no Solidity analogue",
                    stresses: "a host constant read from two different contexts",
                    caveat: "no arbitrator concept in Solidity",
                    axis: "base",
                },
                state: "id fromEntry;\nid fromHook;\nuint64 agreements;\nuint64 disagreements;\nuint64 hookRuns;",
                entries: [
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 agreements;\nuint64 disagreements;\nuint64 hookRuns;\nuint64 entryIsNull;",
                        body: `
                            output.agreements = state.get().agreements;
                            output.disagreements = state.get().disagreements;
                            output.hookRuns = state.get().hookRuns;
                            output.entryIsNull = state.get().fromEntry == NULL_ID ? 1 : 0;
                        `,
                    },
                    {
                        name: "Sample",
                        kind: "procedure",
                        number: 1,
                        locals: "id here;",
                        body: `
                            locals.here = qpi.arbitrator();
                            state.mut().fromEntry = locals.here;
                            if (locals.here == state.get().fromHook)
                            {
                                state.mut().agreements++;
                            }
                            else
                            {
                                state.mut().disagreements++;
                            }
                        `,
                    },
                ],
                initialize:
                    "state.mut().fromEntry = NULL_ID;\nstate.mut().fromHook = NULL_ID;\nstate.mut().agreements = 0;\nstate.mut().disagreements = 0;\nstate.mut().hookRuns = 0;",
                beginTick: "state.mut().fromHook = qpi.arbitrator();\nstate.mut().hookRuns++;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, invocator: 0, note: "before any tick hook has run" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                    { kind: "procedure", entry: 1, invocator: 0, note: "hook and entry should now agree" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 2 },
                    { kind: "procedure", entry: 1, invocator: 0 },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    },
];
