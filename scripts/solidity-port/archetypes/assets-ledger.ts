// Ledger and access-control shapes, from OpenZeppelin.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { identity, u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const OZ = "openzeppelin-contracts/contracts";
const HOLDERS = [identity(1), identity(2), identity(3)];

export const ASSET_LEDGER_ARCHETYPES: Archetype[] = [
    {
        name: "PullPaymentRefundLedger",
        family: "assets",
        solidity: `${OZ}/security/PullPayment.sol`,
        stresses: "credit-then-withdraw accounting: the credit is recorded, the withdrawal zeroes it before paying, and a second withdrawal must find nothing",
        caveat: "There is no external payment to make, so the port records the payout in a total rather than transferring; the accounting order — zero before pay — is what carries over.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "PullPaymentRefundLedger",
                header: {
                    archetype: "PullPaymentRefundLedger",
                    family: "assets",
                    solidity: `${OZ}/security/PullPayment.sol`,
                    stresses: "escrow credit, withdraw-once, double-withdraw",
                    caveat: "the payout is recorded, not transferred",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<id, uint64, ${capacity}> credits;\nuint64 escrowed;\nuint64 paidOut;\nuint64 emptyWithdrawals;`,
                entries: [
                    {
                        name: "Credit",
                        kind: "procedure",
                        number: 1,
                        input: "id payee;\nuint64 amount;",
                        locals: "uint64 current;",
                        body: `
                            locals.current = 0;
                            state.get().credits.get(input.payee, locals.current);
                            state.mut().credits.set(input.payee, locals.current + input.amount);
                            state.mut().escrowed += input.amount;
                        `,
                    },
                    {
                        name: "Withdraw",
                        kind: "procedure",
                        number: 2,
                        output: "uint64 amount;",
                        locals: "id who;\nuint64 owed;",
                        body: `
                            locals.who = qpi.invocator();
                            locals.owed = 0;
                            state.get().credits.get(locals.who, locals.owed);
                            if (locals.owed == 0)
                            {
                                state.mut().emptyWithdrawals++;
                                output.amount = 0;
                                return;
                            }
                            // Zero the credit before recording the payout: the effects-before-interaction
                            // ordering the original exists to demonstrate.
                            state.mut().credits.set(locals.who, 0);
                            state.mut().escrowed -= locals.owed;
                            state.mut().paidOut += locals.owed;
                            output.amount = locals.owed;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "id who;",
                        output: "uint64 credit;\nuint64 escrowed;\nuint64 paidOut;\nuint64 emptyWithdrawals;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            state.get().credits.get(input.who, locals.fetched);
                            output.credit = locals.fetched;
                            output.escrowed = state.get().escrowed;
                            output.paidOut = state.get().paidOut;
                            output.emptyWithdrawals = state.get().emptyWithdrawals;
                        `,
                    },
                ],
                initialize: "state.mut().credits.reset();\nstate.mut().escrowed = 0;\nstate.mut().paidOut = 0;\nstate.mut().emptyWithdrawals = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: HOLDERS[0] + u64(500), invocator: 1 },
                    { kind: "procedure", entry: 1, in: HOLDERS[0] + u64(250), invocator: 1, note: "second credit accumulates" },
                    { kind: "function", entry: 1, in: HOLDERS[0] },
                    { kind: "procedure", entry: 2, invocator: 0, note: "a payee with no credit" },
                    { kind: "function", entry: 1, in: HOLDERS[0] },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "AccessControlRoleBitset",
        family: "assets",
        solidity: `${OZ}/access/AccessControl.sol`,
        stresses: "roles held as a bitmask per account — grant, revoke, renounce, and a guard that tests a role the account never held",
        caveat: "OpenZeppelin keys roles by a 256-bit hash; the port uses a bit position, so a role is a shift rather than a mapping key.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "AccessControlRoleBitset",
                header: {
                    archetype: "AccessControlRoleBitset",
                    family: "assets",
                    solidity: `${OZ}/access/AccessControl.sol`,
                    stresses: "grant/revoke/renounce over a role bitmask, and a shift by an out-of-range role",
                    caveat: "role hashes become bit positions",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<id, uint64, ${capacity}> roles;\nuint64 grants;\nuint64 revocations;\nuint64 guardFailures;`,
                entries: [
                    {
                        name: "Grant",
                        kind: "procedure",
                        number: 1,
                        input: "id who;\nuint64 role;",
                        locals: "uint64 mask;",
                        body: `
                            locals.mask = 0;
                            state.get().roles.get(input.who, locals.mask);
                            state.mut().roles.set(input.who, locals.mask | (1ULL << input.role));
                            state.mut().grants++;
                        `,
                    },
                    {
                        name: "Revoke",
                        kind: "procedure",
                        number: 2,
                        input: "id who;\nuint64 role;",
                        locals: "uint64 mask;",
                        body: `
                            locals.mask = 0;
                            state.get().roles.get(input.who, locals.mask);
                            state.mut().roles.set(input.who, locals.mask & ~(1ULL << input.role));
                            state.mut().revocations++;
                        `,
                    },
                    {
                        name: "Guarded",
                        kind: "procedure",
                        number: 3,
                        input: "uint64 role;",
                        output: "uint64 ok;",
                        locals: "uint64 mask;",
                        body: `
                            locals.mask = 0;
                            state.get().roles.get(qpi.invocator(), locals.mask);
                            if ((locals.mask & (1ULL << input.role)) == 0)
                            {
                                state.mut().guardFailures++;
                                output.ok = 0;
                                return;
                            }
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "id who;",
                        output: "uint64 mask;\nuint64 grants;\nuint64 revocations;\nuint64 guardFailures;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            state.get().roles.get(input.who, locals.fetched);
                            output.mask = locals.fetched;
                            output.grants = state.get().grants;
                            output.revocations = state.get().revocations;
                            output.guardFailures = state.get().guardFailures;
                        `,
                    },
                ],
                initialize: "state.mut().roles.reset();\nstate.mut().grants = 0;\nstate.mut().revocations = 0;\nstate.mut().guardFailures = 0;",
            });
            const actor = HOLDERS[0];
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 3, in: u64(1), invocator: 0, note: "no roles yet" },
                    { kind: "procedure", entry: 1, in: actor + u64(1), invocator: 0 },
                    { kind: "procedure", entry: 1, in: actor + u64(63), invocator: 0, note: "the top bit" },
                    { kind: "procedure", entry: 1, in: actor + u64(64), invocator: 0, note: "shift by the width — undefined in C++, recorded here" },
                    { kind: "function", entry: 1, in: actor },
                    { kind: "procedure", entry: 2, in: actor + u64(1), invocator: 0 },
                    { kind: "function", entry: 1, in: actor },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "NonceMonotonicPerAccount",
        family: "assets",
        solidity: `${OZ}/utils/Nonces.sol`,
        stresses: "a per-account nonce that must increment exactly once per accepted call and not at all for a rejected one",
        caveat: "OpenZeppelin reverts on a bad nonce, which rolls the increment back; QPI has no revert, so the port returns before incrementing and the ordering carries the same meaning.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "NonceMonotonicPerAccount",
                header: {
                    archetype: "NonceMonotonicPerAccount",
                    family: "assets",
                    solidity: `${OZ}/utils/Nonces.sol`,
                    stresses: "nonce checked then incremented, with replays and gaps driven",
                    caveat: "revert becomes an early return before the increment",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<id, uint64, ${capacity}> nonces;\nuint64 accepted;\nuint64 replays;\nuint64 gaps;`,
                entries: [
                    {
                        name: "Use",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 nonce;",
                        output: "uint64 ok;",
                        locals: "id who;\nuint64 expected;",
                        body: `
                            locals.who = qpi.invocator();
                            locals.expected = 0;
                            state.get().nonces.get(locals.who, locals.expected);
                            if (input.nonce < locals.expected)
                            {
                                state.mut().replays++;
                                output.ok = 0;
                                return;
                            }
                            if (input.nonce > locals.expected)
                            {
                                state.mut().gaps++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().nonces.set(locals.who, locals.expected + 1);
                            state.mut().accepted++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "id who;",
                        output: "uint64 next;\nuint64 accepted;\nuint64 replays;\nuint64 gaps;",
                        locals: "uint64 fetched;",
                        body: `
                            locals.fetched = 0;
                            state.get().nonces.get(input.who, locals.fetched);
                            output.next = locals.fetched;
                            output.accepted = state.get().accepted;
                            output.replays = state.get().replays;
                            output.gaps = state.get().gaps;
                        `,
                    },
                ],
                initialize: "state.mut().nonces.reset();\nstate.mut().accepted = 0;\nstate.mut().replays = 0;\nstate.mut().gaps = 0;",
            });
            const steps: CallStep[] = [];
            for (const [nonce, who] of [
                [0n, 0],
                [0n, 0],
                [1n, 0],
                [5n, 0],
                [0n, 1],
                [1n, 1],
            ] as [bigint, number][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(nonce), invocator: who, note: `nonce ${nonce} from actor ${who}` });
            }
            steps.push({ kind: "function", entry: 1, in: HOLDERS[0] });
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "AllowanceIncreaseDecrease",
        family: "assets",
        solidity: `${OZ}/token/ERC20/extensions/ERC20.sol`,
        stresses:
            "increaseAllowance and decreaseAllowance over a two-key table — the addition that may overflow and the subtraction that may underflow, both on the same entry",
        caveat: "The two-key mapping becomes a HashMap keyed on the K12 of the owner and spender pair, so a hash collision is possible where Solidity's nested mapping has none.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "AllowanceIncreaseDecrease",
                header: {
                    archetype: "AllowanceIncreaseDecrease",
                    family: "assets",
                    solidity: `${OZ}/token/ERC20/extensions/ERC20.sol`,
                    stresses: "allowance arithmetic at both boundaries, keyed on a hashed pair",
                    caveat: "the nested mapping becomes one hashed key",
                    axis: `capacity=${capacity}`,
                },
                extraStructs: "struct Pair\n{\n    id owner;\n    id spender;\n};",
                state: `HashMap<id, uint64, ${capacity}> allowances;\nuint64 saturations;\nuint64 underflows;\nuint64 updates;`,
                entries: [
                    {
                        name: "Increase",
                        kind: "procedure",
                        number: 1,
                        input: "id spender;\nuint64 delta;",
                        locals: "Pair pair;\nid key;\nuint64 current;",
                        body: `
                            locals.pair.owner = qpi.invocator();
                            locals.pair.spender = input.spender;
                            locals.key = qpi.K12(locals.pair);
                            locals.current = 0;
                            state.get().allowances.get(locals.key, locals.current);
                            if (locals.current + input.delta < locals.current)
                            {
                                state.mut().saturations++;
                                state.mut().allowances.set(locals.key, 18446744073709551615ULL);
                                return;
                            }
                            state.mut().allowances.set(locals.key, locals.current + input.delta);
                            state.mut().updates++;
                        `,
                    },
                    {
                        name: "Decrease",
                        kind: "procedure",
                        number: 2,
                        input: "id spender;\nuint64 delta;",
                        locals: "Pair pair;\nid key;\nuint64 current;",
                        body: `
                            locals.pair.owner = qpi.invocator();
                            locals.pair.spender = input.spender;
                            locals.key = qpi.K12(locals.pair);
                            locals.current = 0;
                            state.get().allowances.get(locals.key, locals.current);
                            if (locals.current < input.delta)
                            {
                                state.mut().underflows++;
                                state.mut().allowances.set(locals.key, 0);
                                return;
                            }
                            state.mut().allowances.set(locals.key, locals.current - input.delta);
                            state.mut().updates++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        input: "id owner;\nid spender;",
                        output: "uint64 allowance;\nuint64 saturations;\nuint64 underflows;\nuint64 updates;",
                        locals: "Pair pair;\nid key;\nuint64 fetched;",
                        body: `
                            locals.pair.owner = input.owner;
                            locals.pair.spender = input.spender;
                            locals.key = qpi.K12(locals.pair);
                            locals.fetched = 0;
                            state.get().allowances.get(locals.key, locals.fetched);
                            output.allowance = locals.fetched;
                            output.saturations = state.get().saturations;
                            output.underflows = state.get().underflows;
                            output.updates = state.get().updates;
                        `,
                    },
                ],
                initialize: "state.mut().allowances.reset();\nstate.mut().saturations = 0;\nstate.mut().underflows = 0;\nstate.mut().updates = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: HOLDERS[1] + u64(100), invocator: 0 },
                    { kind: "function", entry: 1, in: HOLDERS[0] + HOLDERS[1] },
                    { kind: "procedure", entry: 1, in: HOLDERS[1] + u64(18446744073709551615n), invocator: 0, note: "overflow to saturation" },
                    { kind: "function", entry: 1, in: HOLDERS[0] + HOLDERS[1] },
                    { kind: "procedure", entry: 2, in: HOLDERS[1] + u64(1), invocator: 0 },
                    { kind: "procedure", entry: 2, in: HOLDERS[2] + u64(1), invocator: 0, note: "decrease an allowance that was never granted" },
                    { kind: "function", entry: 1, in: HOLDERS[0] + HOLDERS[2] },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "VestingLinearRelease",
        family: "assets",
        solidity: `${OZ}/finance/VestingWallet.sol`,
        stresses:
            "linearly vested release: `total * elapsed / duration` computed before the division, so the product is where an overflow would land, and the released amount must never decrease",
        caveat: "block.timestamp becomes the tick counter and uint256 becomes uint64, which moves the overflow boundary into reach of the script.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "VestingLinearRelease",
                header: {
                    archetype: "VestingLinearRelease",
                    family: "assets",
                    solidity: `${OZ}/finance/VestingWallet.sol`,
                    stresses: "multiply-then-divide vesting with a monotonic release invariant",
                    caveat: "timestamps become ticks; uint256 becomes uint64",
                    axis: "linear vesting",
                },
                state: "uint64 total;\nuint64 start;\nuint64 duration;\nuint64 released;\nuint64 lastVested;\nuint64 nonMonotonic;",
                entries: [
                    {
                        name: "Release",
                        kind: "procedure",
                        number: 1,
                        output: "uint64 amount;",
                        locals: "uint64 now;\nuint64 elapsed;\nuint64 vested;",
                        body: `
                            locals.now = (uint64)qpi.tick();
                            if (locals.now <= state.get().start)
                            {
                                output.amount = 0;
                                return;
                            }
                            locals.elapsed = locals.now - state.get().start;
                            if (locals.elapsed >= state.get().duration)
                            {
                                locals.vested = state.get().total;
                            }
                            else
                            {
                                locals.vested = QPI::div(state.get().total * locals.elapsed, state.get().duration);
                            }
                            if (locals.vested < state.get().lastVested)
                            {
                                state.mut().nonMonotonic++;
                            }
                            state.mut().lastVested = locals.vested;
                            if (locals.vested <= state.get().released)
                            {
                                output.amount = 0;
                                return;
                            }
                            output.amount = locals.vested - state.get().released;
                            state.mut().released = locals.vested;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 released;\nuint64 lastVested;\nuint64 nonMonotonic;",
                        body: `
                            output.released = state.get().released;
                            output.lastVested = state.get().lastVested;
                            output.nonMonotonic = state.get().nonMonotonic;
                        `,
                    },
                ],
                initialize: `
                    state.mut().total = 1000000000000ULL;
                    state.mut().start = 1000;
                    state.mut().duration = 8;
                    state.mut().released = 0;
                    state.mut().lastVested = 0;
                    state.mut().nonMonotonic = 0;
                `,
            });
            const steps: CallStep[] = [];
            for (let i = 0; i < 10; i++) {
                steps.push({ kind: "procedure", entry: 1, invocator: 0, note: `release at tick offset ${i}` });
                steps.push({ kind: "function", entry: 1 });
                steps.push({ kind: "advanceTick", n: 1 });
            }
            return { source, script: script(steps) };
        },
    },

    {
        name: "StakingRewardPerShare",
        family: "assets",
        solidity: "SushiSwap MasterChef accRewardPerShare accounting",
        stresses:
            "the reward-per-share accumulator every staking contract copies: a scaled global index, a per-account debt, and the subtraction that turns the two into a claim",
        caveat: "The scaling factor is 1e12 in the original against uint256; the port scales by 2^20 so the accumulator stays inside uint64 across the script.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "StakingRewardPerShare",
                header: {
                    archetype: "StakingRewardPerShare",
                    family: "assets",
                    solidity: "MasterChef reward-per-share",
                    stresses: "scaled accumulator, per-account debt, claim by subtraction",
                    caveat: "the 1e12 scale becomes 2^20 to stay inside uint64",
                    axis: `capacity=${capacity}`,
                },
                state: `HashMap<id, uint64, ${capacity}> shares;\nHashMap<id, uint64, ${capacity}> debt;\nuint64 accPerShare;\nuint64 totalShares;\nuint64 claimed;\nuint64 dust;`,
                entries: [
                    {
                        name: "Stake",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        locals: "id who;\nuint64 held;",
                        body: `
                            locals.who = qpi.invocator();
                            locals.held = 0;
                            state.get().shares.get(locals.who, locals.held);
                            state.mut().shares.set(locals.who, locals.held + input.amount);
                            state.mut().totalShares += input.amount;
                            state.mut().debt.set(locals.who, (locals.held + input.amount) * state.get().accPerShare);
                        `,
                    },
                    {
                        name: "Distribute",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 reward;",
                        locals: "uint64 scaled;",
                        body: `
                            if (state.get().totalShares == 0)
                            {
                                state.mut().dust += input.reward;
                                return;
                            }
                            locals.scaled = input.reward << 20;
                            state.mut().accPerShare += QPI::div(locals.scaled, state.get().totalShares);
                            state.mut().dust += QPI::mod(locals.scaled, state.get().totalShares);
                        `,
                    },
                    {
                        name: "Claim",
                        kind: "procedure",
                        number: 3,
                        output: "uint64 amount;",
                        locals: "id who;\nuint64 held;\nuint64 owed;\nuint64 accrued;",
                        body: `
                            locals.who = qpi.invocator();
                            locals.held = 0;
                            state.get().shares.get(locals.who, locals.held);
                            locals.owed = 0;
                            state.get().debt.get(locals.who, locals.owed);
                            locals.accrued = locals.held * state.get().accPerShare;
                            if (locals.accrued <= locals.owed)
                            {
                                output.amount = 0;
                                return;
                            }
                            output.amount = (locals.accrued - locals.owed) >> 20;
                            state.mut().debt.set(locals.who, locals.accrued);
                            state.mut().claimed += output.amount;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 accPerShare;\nuint64 totalShares;\nuint64 claimed;\nuint64 dust;",
                        body: `
                            output.accPerShare = state.get().accPerShare;
                            output.totalShares = state.get().totalShares;
                            output.claimed = state.get().claimed;
                            output.dust = state.get().dust;
                        `,
                    },
                ],
                initialize:
                    "state.mut().shares.reset();\nstate.mut().debt.reset();\nstate.mut().accPerShare = 0;\nstate.mut().totalShares = 0;\nstate.mut().claimed = 0;\nstate.mut().dust = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 2, in: u64(100), invocator: 0, note: "reward with nothing staked — all dust" },
                    { kind: "procedure", entry: 1, in: u64(300), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(100), invocator: 1 },
                    { kind: "procedure", entry: 2, in: u64(1000), invocator: 0, note: "1000 over 400 shares — not divisible" },
                    { kind: "procedure", entry: 3, invocator: 0 },
                    { kind: "procedure", entry: 3, invocator: 1 },
                    { kind: "procedure", entry: 3, invocator: 0, note: "second claim with nothing new accrued" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "TotalSupplyInvariantAcrossOps",
        family: "assets",
        solidity: `${OZ}/token/ERC20/ERC20.sol`,
        stresses:
            "mint, burn and transfer keeping one invariant — the sum of the balances equals the total supply — recomputed from the table after every operation",
        caveat: "The invariant is recomputed by walking a bounded table rather than being asserted, since QPI has no revert; a violation shows up as a non-zero counter in the digest.",
        axes: ["capacity", "fill"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "TotalSupplyInvariantAcrossOps",
                header: {
                    archetype: "TotalSupplyInvariantAcrossOps",
                    family: "assets",
                    solidity: `${OZ}/token/ERC20/ERC20.sol`,
                    stresses: "a supply invariant recomputed from the balances after every mutation",
                    caveat: "the invariant is counted, not asserted",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> balances;\nuint64 totalSupply;\nuint64 invariantBreaks;\nuint64 operations;`,
                entries: [
                    {
                        name: "Mint",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 account;\nuint64 amount;",
                        locals: "uint64 i;\nuint64 sum;",
                        body: `
                            state.mut().balances.set(input.account, state.get().balances.get(input.account) + input.amount);
                            state.mut().totalSupply += input.amount;
                            locals.sum = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.sum += state.get().balances.get(locals.i);
                            }
                            if (locals.sum != state.get().totalSupply)
                            {
                                state.mut().invariantBreaks++;
                            }
                            state.mut().operations++;
                        `,
                    },
                    {
                        name: "Transfer",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 from;\nuint64 to;\nuint64 amount;",
                        locals: "uint64 i;\nuint64 sum;\nuint64 fromBalance;",
                        body: `
                            locals.fromBalance = state.get().balances.get(input.from);
                            if (locals.fromBalance < input.amount)
                            {
                                state.mut().operations++;
                                return;
                            }
                            state.mut().balances.set(input.from, locals.fromBalance - input.amount);
                            state.mut().balances.set(input.to, state.get().balances.get(input.to) + input.amount);
                            locals.sum = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.sum += state.get().balances.get(locals.i);
                            }
                            if (locals.sum != state.get().totalSupply)
                            {
                                state.mut().invariantBreaks++;
                            }
                            state.mut().operations++;
                        `,
                    },
                    {
                        name: "Burn",
                        kind: "procedure",
                        number: 3,
                        input: "uint64 account;\nuint64 amount;",
                        locals: "uint64 i;\nuint64 sum;\nuint64 held;",
                        body: `
                            locals.held = state.get().balances.get(input.account);
                            if (locals.held < input.amount)
                            {
                                state.mut().operations++;
                                return;
                            }
                            state.mut().balances.set(input.account, locals.held - input.amount);
                            state.mut().totalSupply -= input.amount;
                            locals.sum = 0;
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.sum += state.get().balances.get(locals.i);
                            }
                            if (locals.sum != state.get().totalSupply)
                            {
                                state.mut().invariantBreaks++;
                            }
                            state.mut().operations++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 totalSupply;\nuint64 invariantBreaks;\nuint64 operations;\nuint64 firstBalance;",
                        body: `
                            output.totalSupply = state.get().totalSupply;
                            output.invariantBreaks = state.get().invariantBreaks;
                            output.operations = state.get().operations;
                            output.firstBalance = state.get().balances.get(0);
                        `,
                    },
                ],
                initialize: "state.mut().balances.setAll(0);\nstate.mut().totalSupply = 0;\nstate.mut().invariantBreaks = 0;\nstate.mut().operations = 0;",
            });
            const last = BigInt(capacity - 1);
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(0) + u64(1000), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(0) + u64(last) + u64(400), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 3, in: u64(last) + u64(100), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(0) + u64(0) + u64(50), invocator: 0, note: "self transfer" },
                    { kind: "procedure", entry: 1, in: u64(capacity) + u64(1), invocator: 0, note: "index == capacity — Array::set masks to slot 0" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
