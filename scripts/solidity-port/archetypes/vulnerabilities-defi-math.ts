// The arithmetic half of a DeFi exploit: the ratio, the fee, the health factor, the index.
//
// From rekt.news post-mortems, the Damn Vulnerable DeFi exercises and Euler's and Compound's own
// incident write-ups. The adversary does not port — there is no mempool and no flash loan here — but the
// *number* does, and in every one of these incidents the number was reachable by ordinary arithmetic:
// a ratio that truncates, a fee that rounds to zero, an index that drifts, a threshold checked with the
// wrong comparison. Each archetype computes the quantity two ways where a second way exists, and stores
// both, so a backend that lowers one of them differently disagrees with itself.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

export const VULNERABILITY_DEFI_MATH_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "CollateralRatioTruncation",
            family: "vulnerabilities",
            solidity: "compound-protocol/Comptroller.sol (getHypotheticalAccountLiquidity)",
            stresses:
                "a collateral ratio computed as `collateral * 100 / debt` and again as `collateral / (debt / 100)` — the second loses the debt's low digits and lets an undercollateralised position pass",
            caveat: "Compound works in 18-decimal fixed point over uint256; at 64 bits the same truncation arrives at much smaller numbers, which is what makes it reachable in a six-step script.",
        },
        () => ({
            state: "uint64 preciseRatio;\nuint64 sloppyRatio;\nuint64 healthyByPrecise;\nuint64 healthyBySloppy;\nuint64 disagreements;",
            locals: "uint64 debt;\nuint64 scaledDebt;",
            body: `
                locals.debt = input.b == 0 ? 1 : input.b;
                state.mut().preciseRatio = QPI::div(input.a * 100ULL, locals.debt);
                locals.scaledDebt = QPI::div(locals.debt, 100ULL);
                state.mut().sloppyRatio = QPI::div(input.a, locals.scaledDebt == 0 ? 1ULL : locals.scaledDebt);
                state.mut().healthyByPrecise = state.get().preciseRatio >= 150 ? 1 : 0;
                state.mut().healthyBySloppy = state.get().sloppyRatio >= 150 ? 1 : 0;
                if (state.get().healthyByPrecise != state.get().healthyBySloppy)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [300n, 200n],
                [149n, 100n],
                [150n, 100n],
                [1000n, 99n],
                [1n, 1n],
                [18446744073709551615n, 1n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "InterestAccrualCompounding",
            family: "vulnerabilities",
            solidity: "compound-protocol/CToken.sol (accrueInterest)",
            stresses:
                "interest accrued in one step against the same rate applied in four steps — compounding versus simple, where the difference is entirely in when the truncation happens",
        },
        () => ({
            state: "uint64 oneStep;\nuint64 fourSteps;\nuint64 lostToTruncation;\nuint64 stepsTaken;",
            locals: "uint64 principal;\nuint64 rate;\nuint64 i;\nuint64 running;",
            body: `
                locals.principal = input.a;
                locals.rate = QPI::mod(input.b, 1000ULL);
                state.mut().oneStep = locals.principal + QPI::div(locals.principal * locals.rate * 4ULL, 10000ULL);
                locals.running = locals.principal;
                for (locals.i = 0; locals.i < 4; locals.i++)
                {
                    locals.running = locals.running + QPI::div(locals.running * locals.rate, 10000ULL);
                }
                state.mut().fourSteps = locals.running;
                state.mut().stepsTaken = 4;
                if (state.get().fourSteps < state.get().oneStep)
                {
                    state.mut().lostToTruncation = state.get().oneStep - state.get().fourSteps;
                }
                else
                {
                    state.mut().lostToTruncation = 0;
                }
            `,
            pairs: [
                [1000000n, 100n],
                [100n, 100n],
                [1n, 999n],
                [0n, 500n],
                [18446744073709551615n, 1n],
                [123456789n, 37n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SlippageBoundOffByOne",
            family: "vulnerabilities",
            solidity: "uniswap-v2-periphery/UniswapV2Router02.sol (amountOutMin)",
            stresses: "a minimum-output check written with `<` and with `<=` on the same trade — the boundary case where the trade returns exactly the minimum",
        },
        () => ({
            state: "uint64 acceptedStrict;\nuint64 acceptedLenient;\nuint64 boundaryCases;\nuint64 amountOut;",
            locals: "uint64 out;\nuint64 minimum;",
            body: `
                locals.minimum = input.b;
                locals.out = QPI::div(input.a * 997ULL, 1000ULL);
                state.mut().amountOut = locals.out;
                state.mut().acceptedStrict = locals.out > locals.minimum ? 1 : 0;
                state.mut().acceptedLenient = locals.out >= locals.minimum ? 1 : 0;
                if (locals.out == locals.minimum)
                {
                    state.mut().boundaryCases++;
                }
            `,
            pairs: [
                [1000n, 997n],
                [1000n, 998n],
                [1000n, 996n],
                [0n, 0n],
                [1n, 0n],
                [18446744073709551615n, 1n],
            ],
            expect: [
                { pair: 0, values: [0n, 1n, 1n, 997n], note: "exactly the minimum: strict refuses, lenient accepts" },
                { pair: 1, values: [0n, 0n, 1n, 997n], note: "below the minimum" },
                { pair: 2, values: [1n, 1n, 1n, 997n], note: "above it" },
                { pair: 3, values: [0n, 1n, 2n, 0n], note: "zero against zero is another boundary" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "BasisPointsOverflowWindow",
            family: "vulnerabilities",
            solidity: "rekt: fee-in-basis-points overflow",
            stresses:
                "a basis-point fee computed as `amount * bps / 10000`, where the product overflows long before the amount does — with the overflow detected by dividing back",
        },
        () => ({
            state: "uint64 fee;\nuint64 safeFee;\nuint64 overflowed;\nuint64 netAmount;",
            locals: "uint64 bps;\nuint64 product;",
            body: `
                locals.bps = QPI::mod(input.b, 10001ULL);
                locals.product = input.a * locals.bps;
                state.mut().fee = QPI::div(locals.product, 10000ULL);
                if (input.a != 0 && QPI::div(locals.product, input.a) != locals.bps)
                {
                    state.mut().overflowed++;
                    state.mut().safeFee = QPI::div(input.a, 10000ULL) * locals.bps;
                }
                else
                {
                    state.mut().safeFee = state.get().fee;
                }
                state.mut().netAmount = input.a - state.get().safeFee;
            `,
            pairs: [
                [10000n, 250n],
                [1n, 10000n],
                [18446744073709551615n, 250n],
                [1000000000000n, 10000n],
                [0n, 500n],
                [7n, 1n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "HealthFactorThresholdComparison",
            family: "vulnerabilities",
            solidity: "aave-v3-core/LiquidationLogic.sol (healthFactor)",
            stresses:
                "a health factor scaled by 2^16 and compared against one — computed by multiplying first and by dividing first, which disagree exactly at the liquidation boundary",
        },
        () => ({
            state: "uint64 scaledFactor;\nuint64 dividedFirst;\nuint64 liquidatable;\nuint64 liquidatableSloppy;\nuint64 disagreements;",
            locals: "uint64 debt;",
            body: `
                locals.debt = input.b == 0 ? 1 : input.b;
                state.mut().scaledFactor = QPI::div(input.a << 16, locals.debt);
                state.mut().dividedFirst = QPI::div(input.a, locals.debt) << 16;
                state.mut().liquidatable = state.get().scaledFactor < 65536 ? 1 : 0;
                state.mut().liquidatableSloppy = state.get().dividedFirst < 65536 ? 1 : 0;
                if (state.get().liquidatable != state.get().liquidatableSloppy)
                {
                    state.mut().disagreements++;
                }
            `,
            pairs: [
                [100n, 100n],
                [99n, 100n],
                [101n, 100n],
                [1n, 2n],
                [3n, 2n],
                [0n, 5n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "RewardIndexDriftAcrossClaims",
            family: "vulnerabilities",
            solidity: "synthetix/StakingRewards.sol (rewardPerToken)",
            stresses:
                "a reward index advanced in many small steps against the same total advanced in one — the drift is the sum of the truncations, and it only ever goes one way",
        },
        () => ({
            state: "uint64 indexManySteps;\nuint64 indexOneStep;\nuint64 drift;\nuint64 steps;",
            locals: "uint64 supply;\nuint64 reward;\nuint64 i;\nuint64 running;",
            body: `
                locals.supply = input.b == 0 ? 1 : input.b;
                locals.reward = input.a;
                locals.running = 0;
                for (locals.i = 0; locals.i < 8; locals.i++)
                {
                    locals.running += QPI::div(QPI::div(locals.reward, 8ULL) << 20, locals.supply);
                }
                state.mut().indexManySteps = locals.running;
                state.mut().indexOneStep = QPI::div(locals.reward << 20, locals.supply);
                state.mut().steps = 8;
                if (state.get().indexOneStep > state.get().indexManySteps)
                {
                    state.mut().drift = state.get().indexOneStep - state.get().indexManySteps;
                }
                else
                {
                    state.mut().drift = 0;
                }
            `,
            pairs: [
                [800n, 100n],
                [7n, 3n],
                [1000000n, 999983n],
                [0n, 1n],
                [1n, 1n],
                [123456789n, 1000n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "DustBalanceAccounting",
            family: "vulnerabilities",
            solidity: "rekt: dust-balance griefing",
            stresses:
                "a withdrawal that leaves a balance below the dust threshold, with the sweep that is supposed to zero it written two ways — one of which leaves the dust behind",
        },
        () => ({
            state: "uint64 balance;\nuint64 swept;\nuint64 dustLeft;\nuint64 sweeps;",
            locals: "uint64 amount;\nuint64 remaining;",
            body: `
                state.mut().balance = input.a;
                locals.amount = input.b > input.a ? input.a : input.b;
                locals.remaining = input.a - locals.amount;
                if (locals.remaining < 10 && locals.remaining > 0)
                {
                    state.mut().swept += locals.remaining;
                    state.mut().balance = 0;
                    state.mut().sweeps++;
                }
                else
                {
                    state.mut().balance = locals.remaining;
                }
                state.mut().dustLeft = state.get().balance > 0 && state.get().balance < 10 ? state.get().balance : 0;
            `,
            pairs: [
                [100n, 95n],
                [100n, 100n],
                [100n, 89n],
                [9n, 0n],
                [10n, 0n],
                [0n, 5n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ApprovalRaceWindow",
            family: "vulnerabilities",
            solidity: "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol (approve race, SWC-114)",
            stresses:
                "the ERC20 approval race: setting a new allowance without zeroing it first, so a spender who moves in between can spend both — modelled as an ordered pair of operations with the total tracked",
            caveat: "There is no mempool to race in; the port applies the operations in the damaging order deliberately and counts what the spender could take, which is the arithmetic the incident reduces to.",
        },
        () => ({
            state: "uint64 allowance;\nuint64 spentInWindow;\nuint64 safeMaximum;\nuint64 excess;",
            locals: "uint64 first;\nuint64 second;",
            body: `
                locals.first = input.a;
                locals.second = input.b;
                state.mut().allowance = locals.first;
                // The spender empties the old allowance, then the owner overwrites it with the new one.
                state.mut().spentInWindow = locals.first + locals.second;
                state.mut().allowance = locals.second;
                state.mut().safeMaximum = locals.second;
                state.mut().excess = state.get().spentInWindow - state.get().safeMaximum;
            `,
            pairs: [
                [100n, 50n],
                [0n, 100n],
                [100n, 0n],
                [18446744073709551615n, 1n],
                [1n, 18446744073709551615n],
                [7n, 7n],
            ],
            expect: [
                { pair: 0, values: [50n, 150n, 50n, 100n], note: "the spender takes both allowances" },
                { pair: 1, values: [100n, 100n, 100n, 0n], note: "nothing to take before the change" },
                { pair: 2, values: [0n, 100n, 0n, 100n], note: "the old allowance is the whole excess" },
                { pair: 5, values: [7n, 14n, 7n, 7n], note: "equal allowances double the exposure" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "OracleMedianOfThree",
            family: "vulnerabilities",
            solidity: "rekt: single-source oracle manipulation",
            stresses:
                "a median of three prices against their mean — the median resists one manipulated feed and the mean does not, and the two are computed on the same inputs",
        },
        () => ({
            state: "uint64 median;\nuint64 mean;\nuint64 spread;\nuint64 medianResisted;",
            locals: "uint64 first;\nuint64 second;\nuint64 third;\nuint64 low;\nuint64 high;",
            body: `
                locals.first = 1000;
                locals.second = 1010;
                locals.third = input.a;
                locals.low = locals.first < locals.second ? locals.first : locals.second;
                locals.high = locals.first < locals.second ? locals.second : locals.first;
                if (locals.third < locals.low)
                {
                    state.mut().median = locals.low;
                }
                else if (locals.third > locals.high)
                {
                    state.mut().median = locals.high;
                }
                else
                {
                    state.mut().median = locals.third;
                }
                state.mut().mean = QPI::div(locals.first + locals.second + locals.third, 3ULL);
                state.mut().spread = state.get().mean > state.get().median ? state.get().mean - state.get().median : state.get().median - state.get().mean;
                state.mut().medianResisted = state.get().spread > 100 ? 1 : 0;
            `,
            pairs: [
                [1005n, 0n],
                [0n, 0n],
                [1000000n, 0n],
                [1010n, 0n],
                [999n, 0n],
                [18446744073709551615n, 0n],
            ],
            expect: [
                { pair: 0, values: [1005n, 1005n, 0n, 0n], note: "an honest third feed" },
                { pair: 1, values: [1000n, 670n, 330n, 1n], note: "a zeroed feed drags the mean but not the median" },
                { pair: 2, values: [1010n, 334003n, 332993n, 1n], note: "a manipulated high feed" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "WithdrawalQueueOrdering",
            family: "vulnerabilities",
            solidity: "lido/WithdrawalQueue.sol (checkpoint ordering)",
            stresses:
                "a withdrawal queue where the claim is priced at the *request* rate or at the *current* rate — the two differ once the rate moves, and one of them lets a claimant pick the better one",
        },
        () => ({
            state: "uint64 atRequestRate;\nuint64 atCurrentRate;\nuint64 favourable;\nuint64 difference;",
            locals: "uint64 shares;\nuint64 requestRate;\nuint64 currentRate;",
            body: `
                locals.shares = input.a;
                locals.requestRate = 1000;
                locals.currentRate = QPI::mod(input.b, 2001ULL);
                state.mut().atRequestRate = QPI::div(locals.shares * locals.requestRate, 1000ULL);
                state.mut().atCurrentRate = QPI::div(locals.shares * locals.currentRate, 1000ULL);
                if (state.get().atCurrentRate > state.get().atRequestRate)
                {
                    state.mut().favourable++;
                    state.mut().difference = state.get().atCurrentRate - state.get().atRequestRate;
                }
                else
                {
                    state.mut().difference = state.get().atRequestRate - state.get().atCurrentRate;
                }
            `,
            pairs: [
                [100n, 1000n],
                [100n, 2000n],
                [100n, 500n],
                [0n, 2000n],
                [18446744073709551615n, 1000n],
                [3n, 1n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "ThresholdComparisonOffByOne",
            family: "vulnerabilities",
            solidity: "not-so-smart-contracts/incorrect_interface (threshold checks)",
            stresses:
                "a quorum threshold checked four ways — greater, greater-or-equal, and both against a threshold computed by rounding up or down — which agree everywhere except at the boundary",
        },
        () => ({
            state: "uint64 roundedDown;\nuint64 roundedUp;\nuint64 passesStrict;\nuint64 passesLenient;\nuint64 boundary;",
            locals: "uint64 total;\nuint64 votes;",
            body: `
                locals.total = input.b == 0 ? 1 : input.b;
                locals.votes = input.a;
                state.mut().roundedDown = QPI::div(locals.total * 2ULL, 3ULL);
                state.mut().roundedUp = QPI::div(locals.total * 2ULL + 2ULL, 3ULL);
                state.mut().passesStrict = locals.votes > state.get().roundedDown ? 1 : 0;
                state.mut().passesLenient = locals.votes >= state.get().roundedDown ? 1 : 0;
                state.mut().boundary = locals.votes == state.get().roundedDown ? 1 : 0;
            `,
            pairs: [
                [2n, 3n],
                [3n, 3n],
                [67n, 100n],
                [66n, 100n],
                [0n, 0n],
                [4n, 5n],
            ],
            expect: [
                { pair: 0, values: [2n, 2n, 0n, 1n, 1n], note: "two of three is exactly the rounded-down threshold" },
                { pair: 1, values: [2n, 2n, 1n, 1n, 0n], note: "three of three passes either way" },
                { pair: 2, values: [66n, 67n, 1n, 1n, 0n], note: "67 of 100 clears a threshold of 66; rounding up gives 67" },
                { pair: 3, values: [66n, 67n, 0n, 1n, 1n], note: "66 is the boundary case the two spellings disagree on" },
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "FirstDepositorShareInflation",
            family: "vulnerabilities",
            solidity: "rekt: ERC4626 first-depositor inflation",
            stresses:
                "the vault share formula `shares = assets * totalShares / totalAssets` on an empty vault and after a donation — the case where the first depositor's rounding takes the second depositor's deposit",
        },
        () => ({
            state: "uint64 firstShares;\nuint64 secondShares;\nuint64 secondAssetsBack;\nuint64 stolen;",
            locals: "uint64 totalAssets;\nuint64 totalShares;\nuint64 donation;",
            body: `
                locals.donation = input.b;
                state.mut().firstShares = 1;
                locals.totalShares = 1;
                locals.totalAssets = 1 + locals.donation;
                state.mut().secondShares = QPI::div(input.a * locals.totalShares, locals.totalAssets);
                locals.totalShares += state.get().secondShares;
                locals.totalAssets += input.a;
                state.mut().secondAssetsBack = QPI::div(state.get().secondShares * locals.totalAssets, locals.totalShares == 0 ? 1ULL : locals.totalShares);
                state.mut().stolen = input.a > state.get().secondAssetsBack ? input.a - state.get().secondAssetsBack : 0;
            `,
            pairs: [
                [100n, 0n],
                [100n, 1000n],
                [1000n, 1000n],
                [1n, 1000000n],
                [0n, 0n],
                [1000000n, 1n],
            ],
            expect: [
                { pair: 1, values: [1n, 0n, 0n, 100n], note: "a donation of 1000 rounds the second depositor's shares to zero" },
                { pair: 3, values: [1n, 0n, 0n, 1n], note: "one asset against a million donated" },
            ],
        }),
    ),
];
