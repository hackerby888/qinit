// Real shares, not a HashMap standing in for them.
//
// Rounds 1-3 ported ERC20 to a `HashMap<id, uint64, N>` balance table, which tests the compiler's
// container lowering but never touches Qubic's own asset universe. These archetypes use the QPI asset
// API directly — `issueAsset`, `transferShareOwnershipAndPossession`, `numberOfPossessedShares`,
// `isAssetIssued`, `burn` — so the state under comparison is partly *outside* the contract: the two
// backends have to agree on the host calls they make and on what they do with the sint64 status codes
// those calls return. The digest still only covers contract state, so every archetype here mirrors the
// host's answers into its own members; that is what makes an asset-universe difference visible.
//
// Solidity provenance is the ERC20/ERC1155 pattern each one stands for; the port is shape-only by
// definition, because Solidity has no host-side asset registry at all.

import { emitContract } from "../emit";
import { script } from "./common";
import { identity, u64 } from "../encode";
import type { Archetype, CallStep } from "../types";

const OZ = "openzeppelin-contracts/contracts/token";
const HOLDERS = [identity(1), identity(2)];

/** An asset name as QPI encodes it: up to seven ASCII bytes, little-endian, in a uint64. */
function assetName(text: string): bigint {
    let value = 0n;
    for (let index = text.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(text.charCodeAt(index));
    return value;
}

const QAT = assetName("QAT");
const QBT = assetName("QBT");

/** Issue-then-observe, the shape every archetype here starts from. */
function issueSteps(extra: CallStep[] = []): CallStep[] {
    return [
        { kind: "function", entry: 1, note: "before issuance" },
        { kind: "procedure", entry: 1, in: u64(QAT) + u64(1000), invocator: 0, amount: "1000000000", note: "issue 1000 QAT" },
        { kind: "function", entry: 1 },
        ...extra,
        { kind: "advanceTick", n: 1 },
        { kind: "function", entry: 1, note: "after a tick" },
    ];
}

export const ASSET_SHARE_ARCHETYPES: Archetype[] = [
    {
        name: "SharesIssueAndCount",
        family: "assets",
        solidity: `${OZ}/ERC20/ERC20.sol (_mint)`,
        stresses:
            "issueAsset followed by numberOfPossessedShares — a host call whose sint64 result the contract stores, so the two backends must agree on the call and on the value that comes back",
        caveat: "Solidity mints into contract storage; QPI issues into the host's asset universe, which the digest cannot see, so the counts are mirrored into state.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "SharesIssueAndCount",
                header: {
                    archetype: "SharesIssueAndCount",
                    family: "assets",
                    solidity: `${OZ}/ERC20/ERC20.sol`,
                    stresses: "issueAsset and numberOfPossessedShares, mirrored into state",
                    caveat: "the asset universe is host state; only the mirror is in the digest",
                    axis: "issue and count",
                },
                state: "sint64 issueResult;\nsint64 possessed;\nsint64 issuedFlag;\nuint64 calls;",
                entries: [
                    {
                        name: "Issue",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 name;\nsint64 shares;",
                        locals: "sint64 result;",
                        body: `
                            locals.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
                            state.mut().issueResult = locals.result;
                            state.mut().calls++;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 issueResult;\nsint64 possessed;\nsint64 issuedFlag;\nuint64 calls;",
                        locals: "sint64 shares;",
                        body: `
                            locals.shares = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                            output.issueResult = state.get().issueResult;
                            output.possessed = locals.shares;
                            output.issuedFlag = qpi.isAssetIssued(SELF, ${QAT}ULL) ? 1 : 0;
                            output.calls = state.get().calls;
                        `,
                    },
                    {
                        name: "Mirror",
                        kind: "procedure",
                        number: 2,
                        locals: "sint64 shares;",
                        body: `
                            locals.shares = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                            state.mut().possessed = locals.shares;
                            state.mut().issuedFlag = qpi.isAssetIssued(SELF, ${QAT}ULL) ? 1 : 0;
                        `,
                    },
                ],
                initialize: "state.mut().issueResult = 0;\nstate.mut().possessed = 0;\nstate.mut().issuedFlag = 0;\nstate.mut().calls = 0;",
            });
            return {
                source,
                script: script(
                    issueSteps([
                        { kind: "procedure", entry: 2, invocator: 0, note: "mirror the host's count into state" },
                        { kind: "function", entry: 1 },
                    ]),
                ),
            };
        },
    },

    {
        name: "SharesIssueTwiceSameName",
        family: "assets",
        solidity: `${OZ}/ERC20/ERC20.sol (double deploy)`,
        stresses:
            "issuing the same asset name twice — the second call must fail identically on both backends, and the failure code is what the contract stores",
        caveat: "Solidity has no notion of a name already taken at the registry level; the nearest analogue is a second deployment.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "SharesIssueTwiceSameName",
                header: {
                    archetype: "SharesIssueTwiceSameName",
                    family: "assets",
                    solidity: `${OZ}/ERC20/ERC20.sol`,
                    stresses: "a duplicate issuance and the code it returns",
                    caveat: "no Solidity analogue for a name registry",
                    axis: "duplicate issuance",
                },
                state: "sint64 firstResult;\nsint64 secondResult;\nsint64 possessedAfter;\nuint64 attempts;",
                entries: [
                    {
                        name: "IssueTwice",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 name;\nsint64 shares;",
                        locals: "sint64 result;",
                        body: `
                            locals.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);
                            if (state.get().attempts == 0)
                            {
                                state.mut().firstResult = locals.result;
                            }
                            else
                            {
                                state.mut().secondResult = locals.result;
                            }
                            state.mut().attempts++;
                            state.mut().possessedAfter = qpi.numberOfPossessedShares(input.name, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 firstResult;\nsint64 secondResult;\nsint64 possessedAfter;\nuint64 attempts;",
                        body: `
                            output.firstResult = state.get().firstResult;
                            output.secondResult = state.get().secondResult;
                            output.possessedAfter = state.get().possessedAfter;
                            output.attempts = state.get().attempts;
                        `,
                    },
                ],
                initialize: "state.mut().firstResult = 0;\nstate.mut().secondResult = 0;\nstate.mut().possessedAfter = 0;\nstate.mut().attempts = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(QAT) + u64(500), invocator: 0, amount: "1000000000", note: "first issuance" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(QAT) + u64(500), invocator: 0, amount: "1000000000", note: "same name again" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(QBT) + u64(7), invocator: 0, amount: "1000000000", note: "a different name" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "SharesTransferAndBurn",
        family: "assets",
        solidity: `${OZ}/ERC20/ERC20.sol (transfer, _burn)`,
        stresses:
            "transferShareOwnershipAndPossession to a holder, to itself, past the balance, and to NULL_ID — four status codes the contract records, plus the possession count after each",
        caveat: "Solidity reverts on an over-transfer; QPI returns a negative code whose magnitude is the shortfall, which the port stores rather than acting on.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "SharesTransferAndBurn",
                header: {
                    archetype: "SharesTransferAndBurn",
                    family: "assets",
                    solidity: `${OZ}/ERC20/ERC20.sol`,
                    stresses: "four transfer outcomes and the counts they leave",
                    caveat: "a failed transfer is a negative return, not a revert",
                    axis: "transfer outcomes",
                },
                state: "sint64 lastResult;\nsint64 possessedSelf;\nsint64 possessedTarget;\nuint64 transfers;\nuint64 failures;",
                entries: [
                    {
                        name: "Issue",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 name;\nsint64 shares;",
                        locals: "sint64 result;",
                        body: "locals.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);\nstate.mut().lastResult = locals.result;",
                    },
                    {
                        name: "Send",
                        kind: "procedure",
                        number: 2,
                        input: "id target;\nsint64 shares;",
                        output: "sint64 result;",
                        locals: "sint64 result;",
                        body: `
                            locals.result = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, input.shares, input.target);
                            state.mut().lastResult = locals.result;
                            if (locals.result < 0)
                            {
                                state.mut().failures++;
                            }
                            else
                            {
                                state.mut().transfers++;
                            }
                            state.mut().possessedSelf = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                            state.mut().possessedTarget = qpi.numberOfPossessedShares(${QAT}ULL, SELF, input.target, input.target, SELF_INDEX, SELF_INDEX);
                            output.result = locals.result;
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 lastResult;\nsint64 possessedSelf;\nsint64 possessedTarget;\nuint64 transfers;\nuint64 failures;",
                        body: `
                            output.lastResult = state.get().lastResult;
                            output.possessedSelf = state.get().possessedSelf;
                            output.possessedTarget = state.get().possessedTarget;
                            output.transfers = state.get().transfers;
                            output.failures = state.get().failures;
                        `,
                    },
                ],
                initialize:
                    "state.mut().lastResult = 0;\nstate.mut().possessedSelf = 0;\nstate.mut().possessedTarget = 0;\nstate.mut().transfers = 0;\nstate.mut().failures = 0;",
            });
            return {
                source,
                script: script([
                    { kind: "procedure", entry: 1, in: u64(QAT) + u64(1000), invocator: 0, amount: "1000000000" },
                    { kind: "procedure", entry: 2, in: HOLDERS[0] + u64(400), invocator: 0, note: "ordinary transfer" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: HOLDERS[0] + u64(999999), invocator: 0, note: "past the balance" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: "00".repeat(32) + u64(100), invocator: 0, note: "to NULL_ID — a burn" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 2, in: HOLDERS[0] + u64(0), invocator: 0, note: "zero shares" },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 1 },
                ]),
            };
        },
    },

    {
        name: "SharesDecimalsAndUnit",
        family: "assets",
        solidity: `${OZ}/ERC20/extensions/ERC20Metadata.sol`,
        stresses:
            "issuance with the decimal count driven across its signed range — a sint8 parameter the host call takes by value, where a sign-extension difference would change the asset issued",
        caveat: "Solidity's `decimals()` is a view returning uint8; QPI's is a sint8 issuance parameter, so the negative half is reachable here and is not in the original.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "SharesDecimalsAndUnit",
                header: {
                    archetype: "SharesDecimalsAndUnit",
                    family: "assets",
                    solidity: `${OZ}/ERC20/extensions/ERC20Metadata.sol`,
                    stresses: "a sint8 decimals argument at its boundaries",
                    caveat: "decimals is signed in QPI and unsigned in Solidity",
                    axis: "decimals ladder",
                },
                state: "sint64 lastResult;\nsint64 accepted;\nsint64 rejected;\nsint64 lastDecimals;",
                entries: [
                    {
                        name: "Issue",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 name;\nsint8 decimals;\nsint64 shares;\nuint64 unit;",
                        locals: "sint64 result;",
                        body: `
                            locals.result = qpi.issueAsset(input.name, SELF, input.decimals, input.shares, input.unit);
                            state.mut().lastResult = locals.result;
                            state.mut().lastDecimals = (sint64)input.decimals;
                            if (locals.result > 0)
                            {
                                state.mut().accepted++;
                            }
                            else
                            {
                                state.mut().rejected++;
                            }
                        `,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 lastResult;\nsint64 accepted;\nsint64 rejected;\nsint64 lastDecimals;",
                        body: `
                            output.lastResult = state.get().lastResult;
                            output.accepted = state.get().accepted;
                            output.rejected = state.get().rejected;
                            output.lastDecimals = state.get().lastDecimals;
                        `,
                    },
                ],
                initialize: "state.mut().lastResult = 0;\nstate.mut().accepted = 0;\nstate.mut().rejected = 0;\nstate.mut().lastDecimals = 0;",
            });
            const steps: CallStep[] = [];
            // uint64 name, sint8 decimals, 7 bytes of padding, sint64 shares, uint64 unit.
            const pad7 = "00".repeat(7);
            for (const [name, decimals, shares] of [
                [QAT, 0n, 100n],
                [QBT, 127n, 100n],
                [assetName("QCT"), 255n, 100n],
                [assetName("QDT"), 128n, 100n],
            ] as [bigint, bigint, bigint][]) {
                steps.push({
                    kind: "procedure",
                    entry: 1,
                    in: u64(name) + Number(decimals).toString(16).padStart(2, "0") + pad7 + u64(shares) + u64(0),
                    invocator: 0,
                    amount: "1000000000",
                    note: `decimals byte ${decimals}`,
                });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    },

    {
        name: "SharesCountAcrossTicks",
        family: "assets",
        solidity: `${OZ}/ERC20/ERC20.sol (balanceOf across blocks)`,
        stresses: "the possession count read from a tick hook rather than from an entry — a host call made with no user transaction on the stack",
        caveat: "Solidity contracts cannot run between blocks at all, so the hook half has no original.",
        axes: ["placement"],
        build(axis) {
            const source = emitContract({
                axis,
                name: "SharesCountAcrossTicks",
                header: {
                    archetype: "SharesCountAcrossTicks",
                    family: "assets",
                    solidity: `${OZ}/ERC20/ERC20.sol`,
                    stresses: "an asset host call from inside END_TICK",
                    caveat: "no Solidity analogue for between-block execution",
                    axis: "host call in a hook",
                },
                state: "sint64 issued;\nsint64 lastSeenInHook;\nuint64 hookRuns;\nsint64 maxSeen;",
                entries: [
                    {
                        name: "Issue",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 name;\nsint64 shares;",
                        locals: "sint64 result;",
                        body: "locals.result = qpi.issueAsset(input.name, SELF, 0, input.shares, 0);\nstate.mut().issued = locals.result;",
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: "sint64 issued;\nsint64 lastSeenInHook;\nuint64 hookRuns;\nsint64 maxSeen;",
                        body: `
                            output.issued = state.get().issued;
                            output.lastSeenInHook = state.get().lastSeenInHook;
                            output.hookRuns = state.get().hookRuns;
                            output.maxSeen = state.get().maxSeen;
                        `,
                    },
                ],
                initialize: "state.mut().issued = 0;\nstate.mut().lastSeenInHook = 0;\nstate.mut().hookRuns = 0;\nstate.mut().maxSeen = 0;",
                endTick: `
                    state.mut().lastSeenInHook = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                    if (state.get().lastSeenInHook > state.get().maxSeen)
                    {
                        state.mut().maxSeen = state.get().lastSeenInHook;
                    }
                    state.mut().hookRuns++;
                `,
            });
            return {
                source,
                script: script([
                    { kind: "advanceTick", n: 1, note: "hook runs before any issuance" },
                    { kind: "function", entry: 1 },
                    { kind: "procedure", entry: 1, in: u64(QAT) + u64(250), invocator: 0, amount: "1000000000" },
                    { kind: "advanceTick", n: 1 },
                    { kind: "function", entry: 1 },
                    { kind: "advanceTick", n: 2 },
                    { kind: "function", entry: 1 },
                ]),
            };
        },
    },
];
