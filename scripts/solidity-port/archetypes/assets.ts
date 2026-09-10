// Token accounting, money and identity.
//
// Ported from Solidity's `various/erc20.sol`, `payable`, `receive` tests and OpenZeppelin's ERC20 /
// Ownable / Pausable. The balance table is the classic `mapping(address => uint256)`, ported to
// `HashMap<id, uint64, N>`: the width drops from 256 to 64 bits and the map gains a fixed capacity, so
// the overflow boundaries move. What survives unchanged is the accounting shape — the two-key update,
// the allowance decrement, the self-transfer aliasing case — which is what both compilers must agree on.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { identity, u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const SOL = "test/libsolidity/semanticTests";

const HOLDERS = [identity(1), identity(2), identity(3)];

export const ASSET_ARCHETYPES: Archetype[] = [
    {
        name: "Erc20TransferTable",
        family: "assets",
        solidity: `${SOL}/various/erc20.sol`,
        stresses: "the ERC20 balance table: mint, transfer, self-transfer, and a transfer that fails its balance guard",
        caveat: "uint256 becomes uint64 and the unbounded mapping becomes a fixed-capacity HashMap; Solidity's revert-on-insufficient-balance becomes a guard before the writes.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 64);
            const source = emitContract({
                axis,
                name: "Erc20TransferTable",
                header: {
                    archetype: "Erc20TransferTable",
                    family: "assets",
                    solidity: `${SOL}/various/erc20.sol`,
                    stresses: "two-key balance updates including from == to",
                    caveat: "uint256 -> uint64; mapping -> fixed-capacity HashMap; revert -> guard before write",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<id, uint64, ${capacity}> balances;\nuint64 totalSupply;\nuint64 transfers;\nuint64 rejected;`,
                entries: [
                    {
                        name: "Mint",
                        kind: "procedure",
                        number: 1,
                        input: "id to;\nuint64 amount;",
                        locals: "uint64 current;",
                        body: `
                            locals.current = 0;
                            state.get().balances.get(input.to, locals.current);
                            state.mut().balances.set(input.to, locals.current + input.amount);
                            state.mut().totalSupply += input.amount;
                        `,
                    },
                    {
                        name: "Transfer",
                        kind: "procedure",
                        number: 2,
                        input: "id from;\nid to;\nuint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 fromBalance;\nuint64 toBalance;",
                        body: `
                            locals.fromBalance = 0;
                            state.get().balances.get(input.from, locals.fromBalance);
                            if (locals.fromBalance < input.amount)
                            {
                                state.mut().rejected++;
                                output.ok = 0;
                                return;
                            }
                            // Read both balances before writing either: the from == to case must net to zero.
                            locals.toBalance = 0;
                            state.get().balances.get(input.to, locals.toBalance);
                            state.mut().balances.set(input.from, locals.fromBalance - input.amount);
                            locals.toBalance = 0;
                            state.get().balances.get(input.to, locals.toBalance);
                            state.mut().balances.set(input.to, locals.toBalance + input.amount);
                            state.mut().transfers++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "BalanceOf",
                        kind: "function",
                        number: 1,
                        input: "id who;",
                        output: "uint64 balance;\nuint64 totalSupply;\nuint64 transfers;\nuint64 rejected;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            state.get().balances.get(input.who, locals.fetched);
                            output.balance = locals.fetched;
                            output.totalSupply = state.get().totalSupply;
                            output.transfers = state.get().transfers;
                            output.rejected = state.get().rejected;
                        `,
                    },
                ],
                initialize: "state.mut().balances.reset();\nstate.mut().totalSupply = 0;\nstate.mut().transfers = 0;\nstate.mut().rejected = 0;",
            });
            const steps: CallStep[] = [
                { kind: "procedure", entry: 1, in: HOLDERS[0] + u64(1000), invocator: 0, note: "mint to holder 1" },
                { kind: "function", entry: 1, in: HOLDERS[0] },
                { kind: "procedure", entry: 2, in: HOLDERS[0] + HOLDERS[1] + u64(400), invocator: 0, note: "transfer 400" },
                { kind: "function", entry: 1, in: HOLDERS[1] },
                { kind: "procedure", entry: 2, in: HOLDERS[0] + HOLDERS[0] + u64(100), invocator: 0, note: "self-transfer — the aliasing case" },
                { kind: "function", entry: 1, in: HOLDERS[0] },
                { kind: "procedure", entry: 2, in: HOLDERS[1] + HOLDERS[2] + u64(99999), invocator: 0, note: "insufficient balance — guard rejects" },
                { kind: "function", entry: 1, in: HOLDERS[1] },
                { kind: "procedure", entry: 2, in: HOLDERS[0] + HOLDERS[1] + u64(0), invocator: 0, note: "zero-value transfer" },
                { kind: "function", entry: 1, in: HOLDERS[0] },
                { kind: "advanceTick", n: 1 },
            ];
            return { source, script: script(steps) };
        },
    },

    {
        name: "Erc20AllowanceUnderflow",
        family: "assets",
        solidity: `${SOL}/various/erc20.sol`,
        stresses: "transferFrom decrementing an allowance — the subtraction Solidity relies on reverting, which QPI wraps instead",
        caveat: "The Solidity source comment says 'the subtraction here will revert on overflow'. QPI has no revert, so the port guards explicitly and also records what the unguarded wrap would produce.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 64);
            const source = emitContract({
                axis,
                name: "Erc20AllowanceUnderflow",
                header: {
                    archetype: "Erc20AllowanceUnderflow",
                    family: "assets",
                    solidity: `${SOL}/various/erc20.sol`,
                    stresses: "allowance decrement at and below zero",
                    caveat: "Solidity reverts on the underflow; the port records both the guarded and the wrapped result",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<uint64, uint64, ${capacity}> allowances;\nuint64 guarded;\nuint64 wrapped;\nuint64 rejections;`,
                entries: [
                    {
                        name: "Approve",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 key;\nuint64 amount;",
                        locals: "uint64 scratch;",
                        body: "state.mut().allowances.set(input.key, input.amount);",
                    },
                    {
                        name: "Spend",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 key;\nuint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 allowed;",
                        body: `
                            locals.allowed = 0;
                            state.get().allowances.get(input.key, locals.allowed);
                            // What the unguarded Solidity subtraction would leave behind, recorded for comparison.
                            state.mut().wrapped = locals.allowed - input.amount;
                            if (locals.allowed < input.amount)
                            {
                                state.mut().rejections++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().guarded = locals.allowed - input.amount;
                            state.mut().allowances.set(input.key, state.get().guarded);
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 guarded;\nuint64 wrapped;\nuint64 rejections;",
                        body: `
                            output.guarded = state.get().guarded;
                            output.wrapped = state.get().wrapped;
                            output.rejections = state.get().rejections;
                        `,
                    },
                ],
                initialize: "state.mut().allowances.reset();\nstate.mut().guarded = 0;\nstate.mut().wrapped = 0;\nstate.mut().rejections = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(1) + u64(100), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(1) + u64(40), invocator: 0, note: "within allowance" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(1) + u64(1000), invocator: 0, note: "beyond allowance — wrap recorded, guard rejects" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(1) + u64(60), invocator: 0, note: "exactly the remaining allowance" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "InvocatorAndReward",
        family: "assets",
        solidity: `${SOL}/payable/payable_receive.sol`,
        stresses: "msg.sender and msg.value as QPI sees them: invocator, originator and invocationReward, recorded per caller",
        caveat: "Solidity's msg.value is attached to the call; QPI credits the invocation reward to the contract before the body runs.",
        axes: [],
        build(axis) {
            const source = emitContract({
                axis,
                name: "InvocatorAndReward",
                header: {
                    archetype: "InvocatorAndReward",
                    family: "assets",
                    solidity: `${SOL}/payable/payable_receive.sol`,
                    stresses: "invocator / originator / invocationReward",
                    axis: "base",
                },
                state: "id lastInvocator;\nid lastOriginator;\nsint64 totalReward;\nuint64 sameCount;\nuint64 selfCount;",
                entries: [
                    {
                        name: "Pay",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 unused;",
                        locals: "id who;",
                        body: `
                            locals.who = qpi.invocator();
                            state.mut().lastInvocator = locals.who;
                            state.mut().lastOriginator = qpi.originator();
                            state.mut().totalReward += qpi.invocationReward();
                            if (locals.who == qpi.originator())
                            {
                                state.mut().sameCount++;
                            }
                            if (locals.who == SELF)
                            {
                                state.mut().selfCount++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 totalReward;\nuint64 sameCount;\nuint64 selfCount;",
                        body: `
                            output.totalReward = state.get().totalReward;
                            output.sameCount = state.get().sameCount;
                            output.selfCount = state.get().selfCount;
                        `,
                    },
                ],
                initialize: "state.mut().totalReward = 0;\nstate.mut().sameCount = 0;\nstate.mut().selfCount = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 0, amount: "0", note: "no reward" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 0, amount: "1000", note: "reward attached" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 1, amount: "7", note: "a second caller" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "OwnerGuardAndPause",
        family: "assets",
        solidity: "OpenZeppelin Ownable + Pausable",
        stresses: "an owner check and a pause flag gating every mutating entry — the access-control shape most real contracts carry",
        caveat: "Solidity's onlyOwner modifier reverts; the port returns a status and leaves state untouched.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "OwnerGuardAndPause",
                header: {
                    archetype: "OwnerGuardAndPause",
                    family: "assets",
                    solidity: "OpenZeppelin Ownable + Pausable",
                    stresses: "owner identity comparison and a pause bit",
                    axis: `placement=${axis.placement ?? "first"}`,
                },
                state: "id owner;\nbit paused;\nuint64 value;\nuint64 denied;",
                statePlacement: axis.placement,
                entries: [
                    {
                        name: "Claim",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 unused;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().owner == NULL_ID)
                            {
                                state.mut().owner = qpi.invocator();
                            }
                        `,
                    },
                    {
                        name: "SetValue",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 value;",
                        output: "uint64 ok;",
                        locals: "uint64 scratch;",
                        body: `
                            if (state.get().paused == 1 || qpi.invocator() != state.get().owner)
                            {
                                state.mut().denied++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().value = input.value;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "SetPaused",
                        kind: "procedure",
                        number: 3,
                        input: "uint64 paused;",
                        locals: "uint64 scratch;",
                        body: `
                            if (qpi.invocator() == state.get().owner)
                            {
                                state.mut().paused = (input.paused != 0) ? 1 : 0;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 value;\nuint64 denied;\nuint64 paused;",
                        body: `
                            output.value = state.get().value;
                            output.denied = state.get().denied;
                            output.paused = (uint64)state.get().paused;
                        `,
                    },
                ],
                initialize: "state.mut().owner = NULL_ID;\nstate.mut().paused = 0;\nstate.mut().value = 0;\nstate.mut().denied = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(0), invocator: 0, note: "caller 0 claims ownership" },
                    { kind: "procedure", entry: 2, in: u64(5), invocator: 0, note: "owner writes" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(9), invocator: 1, note: "non-owner is denied" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 3, in: u64(1), invocator: 0, note: "owner pauses" },
                    { kind: "procedure", entry: 2, in: u64(7), invocator: 0, note: "paused, so even the owner is denied" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
