// The second cross-contract batch: where the call sits, and what the callee holds.

import { emitContract } from "../emit";
import { script } from "./common";
import { u64 } from "../encode";
import { CALLEE_SLOT } from "./intercontract";
import type { Archetype, AxisAssignment, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests/functionCall";

/** A callee whose state is an Array plus a running total, so an index error moves a different word. */
function vaultCallee(name: string, axis: AxisAssignment, capacity = 8): { name: string; source: string; slot: number } {
    const source = emitContract({
        axis,
        name,
        header: {
            archetype: name,
            family: "intercontract",
            solidity: `${SOL}/external_call.sol`,
            stresses: "a callee holding an Array, so a wrong index across the call boundary lands in a different slot",
            axis: "callee",
        },
        state: `Array<uint64, ${capacity}> slots;\nuint64 total;\nuint64 writes;\nuint64 reads;`,
        entries: [
            {
                name: "Deposit",
                kind: "procedure",
                number: 1,
                input: "uint64 slot;\nuint64 amount;",
                output: "uint64 newBalance;",
                locals: "uint64 current;",
                body: `
                    locals.current = state.get().slots.get(input.slot);
                    state.mut().slots.set(input.slot, locals.current + input.amount);
                    state.mut().total += input.amount;
                    state.mut().writes++;
                    output.newBalance = locals.current + input.amount;
                `,
            },
            {
                name: "Balance",
                kind: "function",
                number: 1,
                input: "uint64 slot;",
                output: "uint64 balance;\nuint64 total;\nuint64 writes;",
                body: `
                    output.balance = state.get().slots.get(input.slot);
                    output.total = state.get().total;
                    output.writes = state.get().writes;
                `,
            },
        ],
        initialize: `state.mut().slots.setAll(0);\nstate.mut().total = 0;\nstate.mut().writes = 0;\nstate.mut().reads = 0;`,
    });
    return { name, source, slot: CALLEE_SLOT };
}

/** Drive one (slot, amount) ladder and read after each. */
function driveSlots(pairs: [bigint, bigint][]): CallStep[] {
    const steps: CallStep[] = [];
    for (const [slot, amount] of pairs) {
        steps.push({ kind: "procedure", entry: 1, in: u64(slot) + u64(amount), invocator: 0, note: `slot ${slot} amount ${amount}` });
        steps.push({ kind: "function", entry: 1 });
    }
    steps.push({ kind: "advanceTick", n: 1 });
    return steps;
}

export const INTERCONTRACT_DAG_ARCHETYPES: Archetype[] = [
    {
        name: "CalleeReadThenWriteSameTick",
        family: "intercontract",
        solidity: `${SOL}/calling_other_functions.sol`,
        stresses:
            "a function call into the callee, then a procedure into the same callee in the same entry — the read must see the pre-write state and the write must be visible to the next read",
        caveat: "Two cross-contract macros in one scope each declare their own error variable, so the second is placed in a nested block.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const callee = vaultCallee("ReadWriteVault", axis);
            const source = emitContract({
                axis,
                name: "CalleeReadThenWriteSameTick",
                header: {
                    archetype: "CalleeReadThenWriteSameTick",
                    family: "intercontract",
                    solidity: `${SOL}/calling_other_functions.sol`,
                    stresses: "read-before-write and read-after-write against one callee",
                    caveat: "the second call sits in its own block so the error variables do not collide",
                    axis: "read then write",
                },
                state: "uint64 balanceBefore;\nuint64 balanceAfter;\nuint64 reported;\nuint64 rounds;",
                entries: [
                    {
                        name: "Round",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 slot;\nuint64 amount;",
                        locals: "ReadWriteVault::Balance_input query;\nReadWriteVault::Balance_output answer;\nReadWriteVault::Deposit_input request;\nReadWriteVault::Deposit_output reply;",
                        body: `
                            locals.query.slot = input.slot;
                            CALL_OTHER_CONTRACT_FUNCTION(ReadWriteVault, Balance, locals.query, locals.answer);
                            state.mut().balanceBefore = locals.answer.balance;
                            {
                                locals.request.slot = input.slot;
                                locals.request.amount = input.amount;
                                INVOKE_OTHER_CONTRACT_PROCEDURE(ReadWriteVault, Deposit, locals.request, locals.reply, 0);
                                state.mut().reported = locals.reply.newBalance;
                            }
                            {
                                locals.query.slot = input.slot;
                                CALL_OTHER_CONTRACT_FUNCTION(ReadWriteVault, Balance, locals.query, locals.answer);
                                state.mut().balanceAfter = locals.answer.balance;
                            }
                            state.mut().rounds++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 balanceBefore;\nuint64 balanceAfter;\nuint64 reported;\nuint64 rounds;",
                        body: `
                            output.balanceBefore = state.get().balanceBefore;
                            output.balanceAfter = state.get().balanceAfter;
                            output.reported = state.get().reported;
                            output.rounds = state.get().rounds;
                        `,
                    },
                ],
                initialize: "state.mut().balanceBefore = 0;\nstate.mut().balanceAfter = 0;\nstate.mut().reported = 0;\nstate.mut().rounds = 0;",
            });
            return {
                source,
                script: script(
                    driveSlots([
                        [0n, 10n],
                        [0n, 5n],
                        [7n, 1n],
                        [8n, 3n],
                        [0n, 18446744073709551615n],
                    ]),
                ),
                callee,
            };
        },
    },

    {
        name: "CalleeInvokedInsideLoop",
        family: "intercontract",
        solidity: `${SOL}/external_call_in_loop.sol`,
        stresses: "the cross-contract invocation inside a loop body — one call per iteration, each with its own error variable in its own scope",
        caveat: "The trip count is bounded by the contract, since a QPI entry has no gas meter to stop it.",
        axes: ["placement", "loopShape"],
        build(axis) {
            const callee = vaultCallee("LoopVault", axis);
            const source = emitContract({
                axis,
                name: "CalleeInvokedInsideLoop",
                header: {
                    archetype: "CalleeInvokedInsideLoop",
                    family: "intercontract",
                    solidity: `${SOL}/external_call_in_loop.sol`,
                    stresses: "one cross-contract call per loop iteration",
                    caveat: "the loop is bounded by the contract, not by gas",
                    axis: "call in a loop",
                },
                state: "uint64 calls;\nuint64 lastReported;\nuint64 sumReported;",
                entries: [
                    {
                        name: "Fan",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;\nuint64 amount;",
                        locals: "uint64 i;\nuint64 bounded;\nLoopVault::Deposit_input request;\nLoopVault::Deposit_output reply;",
                        body: `
                            locals.bounded = input.count;
                            if (locals.bounded > 16)
                            {
                                locals.bounded = 16;
                            }
                            for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                            {
                                locals.request.slot = locals.i;
                                locals.request.amount = input.amount + locals.i;
                                INVOKE_OTHER_CONTRACT_PROCEDURE(LoopVault, Deposit, locals.request, locals.reply, 0);
                                state.mut().lastReported = locals.reply.newBalance;
                                state.mut().sumReported += locals.reply.newBalance;
                                state.mut().calls++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 calls;\nuint64 lastReported;\nuint64 sumReported;",
                        body: `
                            output.calls = state.get().calls;
                            output.lastReported = state.get().lastReported;
                            output.sumReported = state.get().sumReported;
                        `,
                    },
                ],
                initialize: "state.mut().calls = 0;\nstate.mut().lastReported = 0;\nstate.mut().sumReported = 0;",
            });
            return {
                source,
                script: script(
                    driveSlots([
                        [0n, 1n],
                        [3n, 10n],
                        [16n, 2n],
                        [20n, 1n],
                    ]),
                ),
                callee,
            };
        },
    },

    {
        name: "CalleeInvokedFromPrivateProcedure",
        family: "intercontract",
        solidity: `${SOL}/external_call_from_internal.sol`,
        stresses: "the cross-contract call made from a private procedure reached by CALL — two frames deep when the invocation leaves the contract",
        caveat: "The private procedure's locals hold the callee's types, which keeps them out of any public input or output as the hard gate requires.",
        axes: ["placement"],
        build(axis) {
            const callee = vaultCallee("NestedVault", axis);
            const source = emitContract({
                axis,
                name: "CalleeInvokedFromPrivateProcedure",
                header: {
                    archetype: "CalleeInvokedFromPrivateProcedure",
                    family: "intercontract",
                    solidity: `${SOL}/external_call_from_internal.sol`,
                    stresses: "a cross-contract call two frames below the entry",
                    caveat: "callee types live in the private procedure's locals",
                    axis: "call from a private frame",
                },
                state: "uint64 deposits;\nuint64 lastBalance;",
                entries: [
                    {
                        name: "Inner",
                        kind: "procedure",
                        visibility: "private",
                        number: 0,
                        input: "uint64 slot;\nuint64 amount;",
                        output: "uint64 balance;",
                        locals: "NestedVault::Deposit_input request;\nNestedVault::Deposit_output reply;",
                        body: `
                            locals.request.slot = input.slot;
                            locals.request.amount = input.amount;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(NestedVault, Deposit, locals.request, locals.reply, 0);
                            output.balance = locals.reply.newBalance;
                            state.mut().deposits++;
                        `,
                    },
                    {
                        name: "Push",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 slot;\nuint64 amount;",
                        locals: "Inner_input request;\nInner_output reply;",
                        body: `
                            locals.request.slot = input.slot;
                            locals.request.amount = input.amount;
                            CALL(Inner, locals.request, locals.reply);
                            state.mut().lastBalance = locals.reply.balance;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 deposits;\nuint64 lastBalance;",
                        body: "output.deposits = state.get().deposits;\noutput.lastBalance = state.get().lastBalance;",
                    },
                ],
                initialize: "state.mut().deposits = 0;\nstate.mut().lastBalance = 0;",
            });
            return {
                source,
                script: script(
                    driveSlots([
                        [1n, 100n],
                        [1n, 1n],
                        [9n, 4n],
                        [0n, 0n],
                    ]),
                ),
                callee,
            };
        },
    },

    {
        name: "CalleeIndexMaskedAcrossBoundary",
        family: "intercontract",
        solidity: `${SOL}/external_call_array_index.sol`,
        stresses:
            "an out-of-range index sent across the call boundary — Array::get masks it inside the callee, so the caller's own bounds check and the callee's masking must agree on the slot",
        caveat: "Solidity reverts on an out-of-bounds index; QPI masks it, so the port records where the write landed rather than expecting a failure.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const callee = vaultCallee("MaskVault", axis);
            const source = emitContract({
                axis,
                name: "CalleeIndexMaskedAcrossBoundary",
                header: {
                    archetype: "CalleeIndexMaskedAcrossBoundary",
                    family: "intercontract",
                    solidity: `${SOL}/external_call_array_index.sol`,
                    stresses: "index masking inside the callee against a bounds check in the caller",
                    caveat: "an out-of-range index masks rather than reverting",
                    axis: "masked index",
                },
                state: "uint64 forwarded;\nuint64 refusedByCaller;\nuint64 lastSlotAsked;\nuint64 lastBalance;",
                entries: [
                    {
                        name: "Deposit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 slot;\nuint64 amount;",
                        output: "uint64 ok;",
                        locals: "MaskVault::Deposit_input request;\nMaskVault::Deposit_output reply;",
                        body: `
                            state.mut().lastSlotAsked = input.slot;
                            if (input.slot >= 8)
                            {
                                state.mut().refusedByCaller++;
                                output.ok = 0;
                                return;
                            }
                            locals.request.slot = input.slot;
                            locals.request.amount = input.amount;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(MaskVault, Deposit, locals.request, locals.reply, 0);
                            state.mut().lastBalance = locals.reply.newBalance;
                            state.mut().forwarded++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "DepositUnchecked",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 slot;\nuint64 amount;",
                        output: "uint64 balance;",
                        locals: "MaskVault::Deposit_input request;\nMaskVault::Deposit_output reply;",
                        body: `
                            locals.request.slot = input.slot;
                            locals.request.amount = input.amount;
                            INVOKE_OTHER_CONTRACT_PROCEDURE(MaskVault, Deposit, locals.request, locals.reply, 0);
                            state.mut().lastBalance = locals.reply.newBalance;
                            state.mut().forwarded++;
                            output.balance = locals.reply.newBalance;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 forwarded;\nuint64 refusedByCaller;\nuint64 lastSlotAsked;\nuint64 lastBalance;",
                        body: `
                            output.forwarded = state.get().forwarded;
                            output.refusedByCaller = state.get().refusedByCaller;
                            output.lastSlotAsked = state.get().lastSlotAsked;
                            output.lastBalance = state.get().lastBalance;
                        `,
                    },
                ],
                initialize: "state.mut().forwarded = 0;\nstate.mut().refusedByCaller = 0;\nstate.mut().lastSlotAsked = 0;\nstate.mut().lastBalance = 0;",
            });
            const steps: CallStep[] = [];
            for (const [entry, slot, amount] of [
                [1, 0n, 5n],
                [1, 8n, 5n],
                [2, 8n, 5n],
                [2, 9n, 7n],
                [2, 18446744073709551615n, 1n],
            ] as [number, bigint, bigint][]) {
                steps.push({ kind: "procedure", entry, in: u64(slot) + u64(amount), invocator: 0, note: `entry ${entry} slot ${slot}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps), callee };
        },
    },
];
