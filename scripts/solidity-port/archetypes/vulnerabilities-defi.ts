// DeFi failure modes: the arithmetic and ordering bugs that actually drained contracts.
//
// From the SWC registry, rekt.news post-mortems and the Damn Vulnerable DeFi exercises. None of them
// port faithfully — there is no mempool to front-run in, no external call to re-enter through — so each
// archetype keeps the *arithmetic and the ordering* and drops the adversary. What survives is what a
// compiler can get wrong: a rounding step that silently favours one side, a division that reaches zero,
// a constant-product swap whose invariant is checked after the update rather than before.

import { emitContract } from "../emit";
import { capacityOf } from "../axes";
import { script } from "./common";
import { identity, u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const HOLDERS = [identity(1), identity(2)];

export const VULNERABILITY_DEFI_ARCHETYPES: Archetype[] = [
    {
        name: "CommitRevealOrdering",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/bad_randomness (commit-reveal)",
        stresses:
            "a commit-reveal scheme where the commitment is a K12 of a struct and the reveal recomputes it — a mismatch means the wrong bytes were hashed, which is exactly the shape F203 lives in",
        caveat: "The original defends against mempool observation; there is no mempool here, so what remains is the hash-and-compare.",
        axes: ["capacity", "placement"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "CommitRevealOrdering",
                header: {
                    archetype: "CommitRevealOrdering",
                    family: "vulnerabilities",
                    solidity: "commit-reveal randomness",
                    stresses: "commitment recomputed at reveal time",
                    caveat: "no mempool to defend against",
                    axis: `capacity=${capacity}`,
                },
                extraStructs: "struct Commitment\n{\n    id sender;\n    uint64 guess;\n    uint64 salt;\n};",
                state: `HashMap<id, id, ${capacity}> commitments;\nuint64 accepted;\nuint64 mismatched;\nuint64 earlyReveals;\nuint64 winners;`,
                entries: [
                    {
                        name: "Commit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 guess;\nuint64 salt;",
                        locals: "Commitment commitment;\nid digest;",
                        body: `
                            locals.commitment.sender = qpi.invocator();
                            locals.commitment.guess = input.guess;
                            locals.commitment.salt = input.salt;
                            locals.digest = qpi.K12(locals.commitment);
                            state.mut().commitments.set(qpi.invocator(), locals.digest);
                            state.mut().accepted++;
                        `,
                    },
                    {
                        name: "Reveal",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 guess;\nuint64 salt;",
                        output: "uint64 ok;",
                        locals: "Commitment commitment;\nid digest;\nid stored;",
                        body: `
                            locals.stored = NULL_ID;
                            if (!state.get().commitments.get(qpi.invocator(), locals.stored))
                            {
                                state.mut().earlyReveals++;
                                output.ok = 0;
                                return;
                            }
                            locals.commitment.sender = qpi.invocator();
                            locals.commitment.guess = input.guess;
                            locals.commitment.salt = input.salt;
                            locals.digest = qpi.K12(locals.commitment);
                            if (!(locals.digest == locals.stored))
                            {
                                state.mut().mismatched++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().winners += QPI::mod(input.guess, 2ULL);
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 accepted;\nuint64 mismatched;\nuint64 earlyReveals;\nuint64 winners;\nuint64 population;",
                        body: `
                            output.accepted = state.get().accepted;
                            output.mismatched = state.get().mismatched;
                            output.earlyReveals = state.get().earlyReveals;
                            output.winners = state.get().winners;
                            output.population = state.get().commitments.population();
                        `,
                    },
                ],
                initialize:
                    "state.mut().commitments.reset();\nstate.mut().accepted = 0;\nstate.mut().mismatched = 0;\nstate.mut().earlyReveals = 0;\nstate.mut().winners = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 2, in: u64(7) + u64(1), invocator: 0, note: "reveal before commit" },
                    { kind: "procedure", entry: 1, in: u64(7) + u64(1), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(7) + u64(2), invocator: 0, note: "wrong salt" },
                    { kind: "procedure", entry: 2, in: u64(7) + u64(1), invocator: 0, note: "correct reveal" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(8) + u64(9), invocator: 1 },
                    { kind: "procedure", entry: 2, in: u64(8) + u64(9), invocator: 1 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "PrecisionLossRewardSplit",
        family: "vulnerabilities",
        solidity: "rekt: reward-split rounding (SWC-101 adjacent)",
        stresses:
            "a reward divided among holders by share, where dividing before multiplying loses dust and dividing after overflows — both spellings computed and their difference recorded",
        caveat: "The uint256 original does not overflow at these sizes; at 64 bits both failure modes are reachable in the same script, which is the point.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "PrecisionLossRewardSplit",
                header: {
                    archetype: "PrecisionLossRewardSplit",
                    family: "vulnerabilities",
                    solidity: "reward-split rounding",
                    stresses: "divide-then-multiply against multiply-then-divide",
                    caveat: "both failure modes reachable at 64 bits",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> shares;\nuint64 totalShares;\nuint64 paidDivideFirst;\nuint64 paidMultiplyFirst;\nuint64 dust;\nuint64 overflows;`,
                entries: [
                    {
                        name: "Stake",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 index;\nuint64 amount;",
                        locals: "uint64 scratch;",
                        body: `
                            state.mut().shares.set(input.index, state.get().shares.get(input.index) + input.amount);
                            state.mut().totalShares += input.amount;
                        `,
                    },
                    {
                        name: "Distribute",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 reward;",
                        locals: "uint64 i;\nuint64 perShare;\nuint64 divideFirst;\nuint64 multiplyFirst;\nuint64 product;",
                        body: `
                            if (state.get().totalShares == 0)
                            {
                                return;
                            }
                            locals.perShare = QPI::div(input.reward, state.get().totalShares);
                            for (locals.i = 0; locals.i < ${capacity}; locals.i++)
                            {
                                locals.divideFirst = locals.perShare * state.get().shares.get(locals.i);
                                locals.product = input.reward * state.get().shares.get(locals.i);
                                if (state.get().shares.get(locals.i) != 0 && QPI::div(locals.product, state.get().shares.get(locals.i)) != input.reward)
                                {
                                    state.mut().overflows++;
                                    locals.multiplyFirst = locals.divideFirst;
                                }
                                else
                                {
                                    locals.multiplyFirst = QPI::div(locals.product, state.get().totalShares);
                                }
                                state.mut().paidDivideFirst += locals.divideFirst;
                                state.mut().paidMultiplyFirst += locals.multiplyFirst;
                            }
                            state.mut().dust += input.reward - QPI::mod(input.reward, state.get().totalShares) == 0 ? 0 : QPI::mod(input.reward, state.get().totalShares);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 totalShares;\nuint64 paidDivideFirst;\nuint64 paidMultiplyFirst;\nuint64 dust;\nuint64 overflows;",
                        body: `
                            output.totalShares = state.get().totalShares;
                            output.paidDivideFirst = state.get().paidDivideFirst;
                            output.paidMultiplyFirst = state.get().paidMultiplyFirst;
                            output.dust = state.get().dust;
                            output.overflows = state.get().overflows;
                        `,
                    },
                ],
                initialize:
                    "state.mut().shares.setAll(0);\nstate.mut().totalShares = 0;\nstate.mut().paidDivideFirst = 0;\nstate.mut().paidMultiplyFirst = 0;\nstate.mut().dust = 0;\nstate.mut().overflows = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(0) + u64(3), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(1) + u64(7), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(100), invocator: 0, note: "100 over 10 shares — 0 remainder" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(7), invocator: 0, note: "less than one per share" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(18446744073709551615n), invocator: 0, note: "the product overflows" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "ConstantProductSwapInvariant",
        family: "vulnerabilities",
        solidity: "Uniswap V2 core (getAmountOut)",
        stresses:
            "a constant-product swap with the 0.3% fee, where the invariant is recomputed after the trade and compared against the one before — integer truncation means k grows, and by how much is the number under comparison",
        caveat: "Uniswap works in uint256 with a 112-bit reserve; the port uses uint64 reserves, so the same trade sizes stress the multiply far sooner.",
        axes: ["placement", "temporaries"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "ConstantProductSwapInvariant",
                header: {
                    archetype: "ConstantProductSwapInvariant",
                    family: "vulnerabilities",
                    solidity: "Uniswap V2 getAmountOut",
                    stresses: "k before and after a swap, with the fee applied by integer arithmetic",
                    caveat: "uint64 reserves, so the multiply saturates much sooner",
                    axis: "constant product",
                },
                state: "uint64 reserveA;\nuint64 reserveB;\nuint64 kBefore;\nuint64 kAfter;\nuint64 swaps;\nuint64 invariantBroken;",
                entries: [
                    {
                        name: "Swap",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amountIn;",
                        output: "uint64 amountOut;",
                        locals: "uint64 amountInWithFee;\nuint64 numerator;\nuint64 denominator;\nuint64 out;",
                        body: `
                            state.mut().kBefore = state.get().reserveA * state.get().reserveB;
                            locals.amountInWithFee = input.amountIn * 997ULL;
                            locals.numerator = locals.amountInWithFee * state.get().reserveB;
                            locals.denominator = state.get().reserveA * 1000ULL + locals.amountInWithFee;
                            locals.out = QPI::div(locals.numerator, locals.denominator);
                            if (locals.out >= state.get().reserveB)
                            {
                                output.amountOut = 0;
                                return;
                            }
                            state.mut().reserveA += input.amountIn;
                            state.mut().reserveB -= locals.out;
                            state.mut().kAfter = state.get().reserveA * state.get().reserveB;
                            if (state.get().kAfter < state.get().kBefore)
                            {
                                state.mut().invariantBroken++;
                            }
                            state.mut().swaps++;
                            output.amountOut = locals.out;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 reserveA;\nuint64 reserveB;\nuint64 kBefore;\nuint64 kAfter;\nuint64 swaps;\nuint64 invariantBroken;",
                        body: `
                            output.reserveA = state.get().reserveA;
                            output.reserveB = state.get().reserveB;
                            output.kBefore = state.get().kBefore;
                            output.kAfter = state.get().kAfter;
                            output.swaps = state.get().swaps;
                            output.invariantBroken = state.get().invariantBroken;
                        `,
                    },
                ],
                initialize:
                    "state.mut().reserveA = 1000000;\nstate.mut().reserveB = 2000000;\nstate.mut().kBefore = 0;\nstate.mut().kAfter = 0;\nstate.mut().swaps = 0;\nstate.mut().invariantBroken = 0;",
            });
            const steps: CallStep[] = [];
            for (const amount of [1n, 1000n, 100000n, 1000000n, 4294967296n]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount), invocator: 0, note: `swap ${amount} in` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "FeeRoundsToZeroBelowThreshold",
        family: "vulnerabilities",
        solidity: "rekt: fee-on-transfer rounding",
        stresses:
            "a percentage fee that truncates to zero for small amounts, so splitting one transfer into many pays no fee at all — the loop that demonstrates it is in the contract",
        caveat: "The original is an economic attack over many transactions; the port performs the split inside one call so the totals are directly comparable.",
        axes: ["placement", "loopShape"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "FeeRoundsToZeroBelowThreshold",
                header: {
                    archetype: "FeeRoundsToZeroBelowThreshold",
                    family: "vulnerabilities",
                    solidity: "fee-on-transfer rounding",
                    stresses: "one large transfer against many small ones, fee-wise",
                    caveat: "the split happens in-contract",
                    axis: "fee truncation",
                },
                state: "uint64 feeFromOne;\nuint64 feeFromMany;\nuint64 escaped;\nuint64 calls;",
                entries: [
                    {
                        name: "Compare",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;\nuint64 pieces;",
                        locals: "uint64 i;\nuint64 piece;\nuint64 bounded;\nuint64 feeMany;",
                        body: `
                            state.mut().feeFromOne = QPI::div(input.amount * 3ULL, 1000ULL);
                            locals.bounded = input.pieces == 0 ? 1 : input.pieces;
                            if (locals.bounded > 64)
                            {
                                locals.bounded = 64;
                            }
                            locals.piece = QPI::div(input.amount, locals.bounded);
                            locals.feeMany = 0;
                            for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                            {
                                locals.feeMany += QPI::div(locals.piece * 3ULL, 1000ULL);
                            }
                            state.mut().feeFromMany = locals.feeMany;
                            if (locals.feeMany < state.get().feeFromOne)
                            {
                                state.mut().escaped += state.get().feeFromOne - locals.feeMany;
                            }
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 feeFromOne;\nuint64 feeFromMany;\nuint64 escaped;\nuint64 calls;",
                        body: `
                            output.feeFromOne = state.get().feeFromOne;
                            output.feeFromMany = state.get().feeFromMany;
                            output.escaped = state.get().escaped;
                            output.calls = state.get().calls;
                        `,
                    },
                ],
                initialize: "state.mut().feeFromOne = 0;\nstate.mut().feeFromMany = 0;\nstate.mut().escaped = 0;\nstate.mut().calls = 0;",
            });
            const steps: CallStep[] = [];
            for (const [amount, pieces] of [
                [1000n, 1n],
                [1000n, 10n],
                [1000n, 64n],
                [333n, 3n],
                [1n, 1n],
            ] as [bigint, bigint][]) {
                steps.push({ kind: "procedure", entry: 1, in: u64(amount) + u64(pieces), invocator: 0, note: `${amount} in ${pieces} pieces` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "EffectsAfterInteractionOrdering",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/reentrancy (checks-effects-interactions)",
        stresses:
            "the withdrawal written both ways — balance zeroed before the payout and after it — with a re-entry flag standing in for the callback QPI cannot make",
        caveat: "QPI's call graph is a DAG, so there is no callback to re-enter through; the flag records what a re-entrant call *would* have seen, which is the residue of the original bug.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "EffectsAfterInteractionOrdering",
                header: {
                    archetype: "EffectsAfterInteractionOrdering",
                    family: "vulnerabilities",
                    solidity: "checks-effects-interactions",
                    stresses: "zero-before-pay against pay-before-zero",
                    caveat: "no real re-entry is possible; the flag is the residue",
                    axis: "effects ordering",
                },
                state: "uint64 safeBalance;\nuint64 unsafeBalance;\nuint64 observedDuringPay;\nuint64 paidSafe;\nuint64 paidUnsafe;",
                entries: [
                    {
                        name: "Deposit",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        locals: "uint64 scratch;",
                        body: "state.mut().safeBalance += input.amount;\nstate.mut().unsafeBalance += input.amount;",
                    },
                    {
                        name: "WithdrawSafe",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 held;",
                        body: `
                            locals.held = state.get().safeBalance;
                            if (locals.held < input.amount)
                            {
                                output.ok = 0;
                                return;
                            }
                            state.mut().safeBalance = locals.held - input.amount;
                            state.mut().paidSafe += input.amount;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "WithdrawUnsafe",
                        kind: "procedure",
                        number: 3,
                        input: "uint64 amount;",
                        output: "uint64 ok;",
                        locals: "uint64 held;",
                        body: `
                            locals.held = state.get().unsafeBalance;
                            if (locals.held < input.amount)
                            {
                                output.ok = 0;
                                return;
                            }
                            state.mut().paidUnsafe += input.amount;
                            // What a re-entrant caller would read here: the balance is still the old one.
                            state.mut().observedDuringPay = state.get().unsafeBalance;
                            state.mut().unsafeBalance = locals.held - input.amount;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 safeBalance;\nuint64 unsafeBalance;\nuint64 observedDuringPay;\nuint64 paidSafe;\nuint64 paidUnsafe;",
                        body: `
                            output.safeBalance = state.get().safeBalance;
                            output.unsafeBalance = state.get().unsafeBalance;
                            output.observedDuringPay = state.get().observedDuringPay;
                            output.paidSafe = state.get().paidSafe;
                            output.paidUnsafe = state.get().paidUnsafe;
                        `,
                    },
                ],
                initialize:
                    "state.mut().safeBalance = 0;\nstate.mut().unsafeBalance = 0;\nstate.mut().observedDuringPay = 0;\nstate.mut().paidSafe = 0;\nstate.mut().paidUnsafe = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(100), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(40), invocator: 0 },
                    { kind: "procedure", entry: 3, in: u64(40), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: u64(100), invocator: 0, note: "over balance" },
                    { kind: "procedure", entry: 3, in: u64(100), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "SignatureReplayWithoutNonce",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/signature_replay (SWC-121)",
        stresses: "an authorisation digest that carries no nonce, accepted twice, next to the same digest with a nonce folded in that is accepted once",
        caveat: "There is no real signature check here — the digest is a K12 of the request — so what is compared is the replay bookkeeping, not the cryptography.",
        axes: ["capacity"],
        build(axis) {
            const capacity = capacityOf(axis, 8);
            const source = emitContract({
                axis,
                name: "SignatureReplayWithoutNonce",
                header: {
                    archetype: "SignatureReplayWithoutNonce",
                    family: "vulnerabilities",
                    solidity: "signature replay (SWC-121)",
                    stresses: "replayable digests against nonce-bound ones",
                    caveat: "K12 stands in for the signature check",
                    axis: `capacity=${capacity}`,
                },
                extraStructs:
                    "struct Request\n{\n    id who;\n    uint64 amount;\n};\n\nstruct BoundRequest\n{\n    id who;\n    uint64 amount;\n    uint64 nonce;\n};",
                state: `HashSet<id, ${capacity}> usedDigests;\nuint64 paidReplayable;\nuint64 paidBound;\nuint64 replaysAccepted;\nuint64 replaysRefused;\nuint64 nextNonce;`,
                entries: [
                    {
                        name: "PayReplayable",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 amount;",
                        locals: "Request request;\nid digest;",
                        body: `
                            locals.request.who = qpi.invocator();
                            locals.request.amount = input.amount;
                            locals.digest = qpi.K12(locals.request);
                            // No nonce and no record: the same digest is accepted for ever.
                            state.mut().paidReplayable += input.amount;
                            state.mut().replaysAccepted++;
                        `,
                    },
                    {
                        name: "PayBound",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 amount;\nuint64 nonce;",
                        output: "uint64 ok;",
                        locals: "BoundRequest request;\nid digest;\nsint64 slot;",
                        body: `
                            locals.request.who = qpi.invocator();
                            locals.request.amount = input.amount;
                            locals.request.nonce = input.nonce;
                            locals.digest = qpi.K12(locals.request);
                            if (state.get().usedDigests.contains(locals.digest))
                            {
                                state.mut().replaysRefused++;
                                output.ok = 0;
                                return;
                            }
                            locals.slot = state.mut().usedDigests.add(locals.digest);
                            state.mut().paidBound += input.amount;
                            state.mut().nextNonce = input.nonce + 1;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 paidReplayable;\nuint64 paidBound;\nuint64 replaysAccepted;\nuint64 replaysRefused;\nuint64 population;",
                        body: `
                            output.paidReplayable = state.get().paidReplayable;
                            output.paidBound = state.get().paidBound;
                            output.replaysAccepted = state.get().replaysAccepted;
                            output.replaysRefused = state.get().replaysRefused;
                            output.population = state.get().usedDigests.population();
                        `,
                    },
                ],
                initialize:
                    "state.mut().usedDigests.reset();\nstate.mut().paidReplayable = 0;\nstate.mut().paidBound = 0;\nstate.mut().replaysAccepted = 0;\nstate.mut().replaysRefused = 0;\nstate.mut().nextNonce = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(50), invocator: 0 },
                    { kind: "procedure", entry: 1, in: u64(50), invocator: 0, note: "identical request, accepted again" },
                    { kind: "procedure", entry: 2, in: u64(50) + u64(0), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(50) + u64(0), invocator: 0, note: "same nonce — refused" },
                    { kind: "procedure", entry: 2, in: u64(50) + u64(1), invocator: 0 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "UnboundedIterationCostCounter",
        family: "vulnerabilities",
        solidity: "not-so-smart-contracts/dos (SWC-128)",
        stresses:
            "a loop over a table whose length the caller controls, with the work counted — the shape that runs out of gas on Ethereum and simply runs long here",
        caveat: "There is no gas meter in a QPI entry, so the port bounds the loop and records how much work the caller could have demanded.",
        axes: ["capacity", "loopShape"],
        build(axis) {
            const capacity = capacityOf(axis, 64);
            const source = emitContract({
                axis,
                name: "UnboundedIterationCostCounter",
                header: {
                    archetype: "UnboundedIterationCostCounter",
                    family: "vulnerabilities",
                    solidity: "denial of service by unbounded loop (SWC-128)",
                    stresses: "caller-controlled trip count, bounded and counted",
                    caveat: "no gas meter to run out of",
                    axis: `capacity=${capacity}`,
                },
                state: `Array<uint64, ${capacity}> entries;\nuint64 filled;\nuint64 workDone;\nuint64 workRequested;\nuint64 clamped;`,
                entries: [
                    {
                        name: "Register",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 count;",
                        locals: "uint64 i;\nuint64 bounded;",
                        body: `
                            locals.bounded = input.count > ${capacity} ? ${capacity} : input.count;
                            for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                            {
                                state.mut().entries.set(locals.i, locals.i + 1);
                            }
                            state.mut().filled = locals.bounded;
                        `,
                    },
                    {
                        name: "Sweep",
                        kind: "procedure",
                        number: 2,
                        input: "uint64 requested;",
                        locals: "uint64 i;\nuint64 bounded;\nuint64 total;",
                        body: `
                            state.mut().workRequested += input.requested;
                            locals.bounded = input.requested;
                            if (locals.bounded > state.get().filled)
                            {
                                locals.bounded = state.get().filled;
                                state.mut().clamped++;
                            }
                            locals.total = 0;
                            for (locals.i = 0; locals.i < locals.bounded; locals.i++)
                            {
                                locals.total += state.get().entries.get(locals.i);
                                state.mut().workDone++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 filled;\nuint64 workDone;\nuint64 workRequested;\nuint64 clamped;",
                        body: `
                            output.filled = state.get().filled;
                            output.workDone = state.get().workDone;
                            output.workRequested = state.get().workRequested;
                            output.clamped = state.get().clamped;
                        `,
                    },
                ],
                initialize:
                    "state.mut().entries.setAll(0);\nstate.mut().filled = 0;\nstate.mut().workDone = 0;\nstate.mut().workRequested = 0;\nstate.mut().clamped = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(capacity), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(1), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(capacity), invocator: 0 },
                    { kind: "procedure", entry: 2, in: u64(18446744073709551615n), invocator: 0, note: "everything the caller can ask for" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "OwnerTransferTwoStepRace",
        family: "vulnerabilities",
        solidity: "openzeppelin-contracts/contracts/access/Ownable2Step.sol",
        stresses:
            "two-step ownership transfer against the one-step version — the pending owner slot, the accept that clears it, and an accept from the wrong caller",
        caveat: "Ownable2Step exists because a one-step transfer to a wrong address is unrecoverable; the port keeps both and counts which one loses control.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "OwnerTransferTwoStepRace",
                header: {
                    archetype: "OwnerTransferTwoStepRace",
                    family: "vulnerabilities",
                    solidity: "Ownable2Step",
                    stresses: "pending-owner bookkeeping and a wrong-caller accept",
                    caveat: "both transfer styles in one contract",
                    axis: "two-step ownership",
                },
                state: "id owner;\nid pending;\nid oneStepOwner;\nuint64 accepted;\nuint64 refused;\nuint64 oneStepTransfers;",
                entries: [
                    {
                        name: "Offer",
                        kind: "procedure",
                        number: 1,
                        input: "id candidate;",
                        output: "uint64 ok;",
                        locals: "id caller;",
                        body: `
                            locals.caller = qpi.invocator();
                            if (!(state.get().owner == locals.caller))
                            {
                                state.mut().refused++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().pending = input.candidate;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "Accept",
                        kind: "procedure",
                        number: 2,
                        output: "uint64 ok;",
                        locals: "id caller;",
                        body: `
                            locals.caller = qpi.invocator();
                            if (!(state.get().pending == locals.caller))
                            {
                                state.mut().refused++;
                                output.ok = 0;
                                return;
                            }
                            state.mut().owner = locals.caller;
                            state.mut().pending = NULL_ID;
                            state.mut().accepted++;
                            output.ok = 1;
                        `,
                    },
                    {
                        name: "TransferOneStep",
                        kind: "procedure",
                        number: 3,
                        input: "id newOwner;",
                        locals: "id caller;",
                        body: `
                            locals.caller = qpi.invocator();
                            if (state.get().oneStepOwner == locals.caller || state.get().oneStepOwner == NULL_ID)
                            {
                                state.mut().oneStepOwner = input.newOwner;
                                state.mut().oneStepTransfers++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "uint64 accepted;\nuint64 refused;\nuint64 oneStepTransfers;\nuint64 pendingIsNull;\nuint64 ownerIsSelf;",
                        body: `
                            output.accepted = state.get().accepted;
                            output.refused = state.get().refused;
                            output.oneStepTransfers = state.get().oneStepTransfers;
                            output.pendingIsNull = state.get().pending == NULL_ID ? 1 : 0;
                            output.ownerIsSelf = state.get().owner == SELF ? 1 : 0;
                        `,
                    },
                ],
                initialize:
                    "state.mut().owner = SELF;\nstate.mut().pending = NULL_ID;\nstate.mut().oneStepOwner = NULL_ID;\nstate.mut().accepted = 0;\nstate.mut().refused = 0;\nstate.mut().oneStepTransfers = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: HOLDERS[0], invocator: 0, note: "not the owner — refused" },
                    { kind: "procedure", entry: 2, invocator: 0, note: "nothing pending" },
                    { kind: "procedure", entry: 3, in: HOLDERS[0], invocator: 0, note: "one-step transfer to a stranger" },
                    { kind: "procedure", entry: 3, in: HOLDERS[1], invocator: 0, note: "and now the caller has lost it" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },
];
