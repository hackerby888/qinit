// More share-API accounting: issuance limits, ownership versus possession, and the codes the host
// returns when a transfer cannot be made.
//
// Round 4 established that the asset universe is reachable from a contract and that both backends drive
// it the same way. These archetypes push on the *edges* of that API — a zero-share issuance, a negative
// count, a transfer to the issuer, a transfer of everything followed by one more — because each of those
// is a signed return code the contract has to interpret, and interpreting a code is code generation.

import { twoOperandArchetype } from "./common";
import type { Archetype } from "../types";

const OZ = "openzeppelin-contracts/contracts/token";

/** "QAT" as QPI encodes an asset name: ASCII bytes, little-endian, in a uint64. */
const QAT = 5525825n;

export const ASSET_MORE_ARCHETYPES: Archetype[] = [
    twoOperandArchetype(
        {
            name: "SharesIssueEdgeCounts",
            family: "assets",
            solidity: `${OZ}/ERC20/ERC20.sol (_mint)`,
            stresses:
                "issuance at zero, one, the maximum and a negative count — four share counts the host validates differently, with the returned code stored each time",
            caveat: "Solidity's _mint takes an unsigned amount; QPI's issueAsset takes a signed one, so the negative half of the range exists only in the port.",
        },
        () => ({
            state: `sint64 result;\nsint64 possessed;\nuint64 accepted;\nuint64 refused;`,
            locals: "sint64 outcome;",
            body: `
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, (sint64)input.a, 0);
                state.mut().result = locals.outcome;
                if (locals.outcome > 0)
                {
                    state.mut().accepted++;
                }
                else
                {
                    state.mut().refused++;
                }
                state.mut().possessed = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
            `,
            pairs: [
                [0n, 0n],
                [1n, 0n],
                [1000n, 0n],
                [18446744073709551615n, 0n],
                [9223372036854775807n, 0n],
                [100n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesOwnershipVersusPossession",
            family: "assets",
            solidity: `${OZ}/ERC721/ERC721.sol (ownerOf versus approved)`,
            stresses:
                "numberOfPossessedShares asked with the contract as owner and as possessor, and with a stranger in each position — four combinations of the same query",
            caveat: "Solidity's ERC721 separates owner from approved operator; QPI separates ownership from possession at the protocol level, which is close but not the same split.",
        },
        () => ({
            state: `sint64 selfSelf;\nsint64 selfStranger;\nsint64 strangerSelf;\nsint64 strangerStranger;\nsint64 issued;`,
            locals: "id stranger;\nsint64 outcome;",
            body: `
                locals.stranger = qpi.K12(input.b);
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, (sint64)QPI::mod(input.a, 100000ULL), 0);
                state.mut().issued = locals.outcome;
                state.mut().selfSelf = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().selfStranger = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, locals.stranger, SELF_INDEX, SELF_INDEX);
                state.mut().strangerSelf = qpi.numberOfPossessedShares(${QAT}ULL, SELF, locals.stranger, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().strangerStranger = qpi.numberOfPossessedShares(${QAT}ULL, SELF, locals.stranger, locals.stranger, SELF_INDEX, SELF_INDEX);
            `,
            pairs: [
                [1000n, 1n],
                [0n, 1n],
                [500n, 2n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesTransferEverythingThenMore",
            family: "assets",
            solidity: `${OZ}/ERC20/ERC20.sol (transfer)`,
            stresses:
                "transferring the entire balance and then one share more — the second call's negative return is the shortfall, and the port stores its magnitude",
        },
        () => ({
            state: `sint64 firstTransfer;\nsint64 secondTransfer;\nsint64 remaining;\nuint64 shortfalls;`,
            locals: "id target;\nsint64 issued;\nsint64 outcome;",
            body: `
                locals.target = qpi.K12(input.b);
                locals.issued = qpi.issueAsset(${QAT}ULL, SELF, 0, (sint64)QPI::mod(input.a, 100000ULL), 0);
                locals.outcome = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, locals.issued, locals.target);
                state.mut().firstTransfer = locals.outcome;
                locals.outcome = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, 1, locals.target);
                state.mut().secondTransfer = locals.outcome;
                if (locals.outcome < 0)
                {
                    state.mut().shortfalls++;
                }
                state.mut().remaining = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
            `,
            pairs: [
                [1000n, 1n],
                [1n, 2n],
                [0n, 3n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesTransferToIssuerAndSelf",
            family: "assets",
            solidity: `${OZ}/ERC20/ERC20.sol (self-transfer)`,
            stresses:
                "a transfer whose destination is the sender, and one whose destination is the issuer — the aliasing cases where a naive implementation debits before crediting and loses the shares",
        },
        () => ({
            state: `sint64 selfTransfer;\nsint64 issuerTransfer;\nsint64 balanceAfter;\nuint64 preserved;`,
            locals: "sint64 issued;\nsint64 before;",
            body: `
                locals.issued = qpi.issueAsset(${QAT}ULL, SELF, 0, (sint64)QPI::mod(input.a, 100000ULL), 0);
                locals.before = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().selfTransfer = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, (sint64)QPI::mod(input.b, 100ULL), SELF);
                state.mut().issuerTransfer = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, (sint64)QPI::mod(input.b, 100ULL), SELF);
                state.mut().balanceAfter = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().preserved = state.get().balanceAfter == locals.before ? 1 : 0;
            `,
            pairs: [
                [1000n, 10n],
                [1000n, 0n],
                [50n, 99n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesNameEncodingLadder",
            family: "assets",
            solidity: `${OZ}/ERC20/extensions/ERC20Metadata.sol (name)`,
            stresses:
                "asset names at the edges of the seven-byte encoding — one letter, seven letters, a name with a zero byte in the middle, and one with the high byte set",
            caveat: "The name is a uint64 of ASCII bytes; Solidity's is a string, so nothing about the encoding carries over, only the fact that the host validates it.",
        },
        () => ({
            state: `sint64 result;\nuint64 accepted;\nuint64 refused;\nuint64 lastName;`,
            locals: "uint64 name;\nsint64 outcome;",
            body: `
                locals.name = input.a;
                locals.outcome = qpi.issueAsset(locals.name, SELF, 0, 100, 0);
                state.mut().result = locals.outcome;
                state.mut().lastName = locals.name;
                if (locals.outcome > 0)
                {
                    state.mut().accepted++;
                }
                else
                {
                    state.mut().refused++;
                }
            `,
            pairs: [
                [81n, 0n],
                [5525825n, 0n],
                [24052398214276433n, 0n],
                [21315n, 0n],
                [18446744073709551615n, 0n],
                [0n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesUnitOfMeasurementRoundTrip",
            family: "assets",
            solidity: `${OZ}/ERC20/extensions/ERC20Metadata.sol (decimals)`,
            stresses:
                "the unit-of-measurement word carried through issuance — an eight-byte field the host stores and the contract never reads back, so its only effect is on whether the issuance is accepted",
        },
        () => ({
            state: `sint64 result;\nuint64 accepted;\nuint64 distinctUnits;\nuint64 lastUnit;`,
            locals: "sint64 outcome;",
            body: `
                locals.outcome = qpi.issueAsset(${QAT}ULL + QPI::mod(input.b, 8ULL), SELF, 0, 100, input.a);
                state.mut().result = locals.outcome;
                if (locals.outcome > 0)
                {
                    state.mut().accepted++;
                }
                if (input.a != state.get().lastUnit)
                {
                    state.mut().distinctUnits++;
                }
                state.mut().lastUnit = input.a;
            `,
            pairs: [
                [0n, 0n],
                [1n, 1n],
                [18446744073709551615n, 2n],
                [1n, 3n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesMultipleAssetsOneContract",
            family: "assets",
            solidity: `${OZ}/ERC1155/ERC1155.sol`,
            stresses:
                "three assets issued by one contract and counted separately — the multi-token case, where a query for one name must not see another's shares",
        },
        () => ({
            state: `sint64 firstCount;\nsint64 secondCount;\nsint64 thirdCount;\nuint64 issued;`,
            locals: "sint64 outcome;\nuint64 amount;",
            body: `
                locals.amount = QPI::mod(input.a, 10000ULL) + 1;
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, (sint64)locals.amount, 0);
                if (locals.outcome > 0)
                {
                    state.mut().issued++;
                }
                locals.outcome = qpi.issueAsset(${QAT}ULL + 1, SELF, 0, (sint64)(locals.amount * 2), 0);
                if (locals.outcome > 0)
                {
                    state.mut().issued++;
                }
                locals.outcome = qpi.issueAsset(${QAT}ULL + 2, SELF, 0, (sint64)(locals.amount * 3), 0);
                if (locals.outcome > 0)
                {
                    state.mut().issued++;
                }
                state.mut().firstCount = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().secondCount = qpi.numberOfPossessedShares(${QAT}ULL + 1, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().thirdCount = qpi.numberOfPossessedShares(${QAT}ULL + 2, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
            `,
            pairs: [
                [100n, 0n],
                [0n, 0n],
                [9999n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesQueryUnknownAsset",
            family: "assets",
            solidity: `${OZ}/ERC20/ERC20.sol (balanceOf of an unknown token)`,
            stresses:
                "counting shares of an asset nobody issued, of an asset issued by someone else, and of the null issuer — three queries that must all answer without inventing shares",
        },
        () => ({
            state: `sint64 unknownName;\nsint64 strangerIssuer;\nsint64 nullIssuer;\nsint64 own;`,
            locals: "id stranger;\nsint64 outcome;",
            body: `
                locals.stranger = qpi.K12(input.b);
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, 500, 0);
                state.mut().own = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().unknownName = qpi.numberOfPossessedShares(input.a, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().strangerIssuer = qpi.numberOfPossessedShares(${QAT}ULL, locals.stranger, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().nullIssuer = qpi.numberOfPossessedShares(${QAT}ULL, NULL_ID, SELF, SELF, SELF_INDEX, SELF_INDEX);
            `,
            pairs: [
                [999999n, 1n],
                [0n, 2n],
                [5525825n, 3n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesManagingContractIndexes",
            family: "assets",
            solidity: "no Solidity analogue (managing contract indices)",
            stresses:
                "the ownership- and possession-managing contract indices in a share query — two uint16 arguments that select whose rules apply, driven at this contract's index, at zero and past the end",
            caveat: "Ethereum has no notion of a managing contract for a token balance; this is protocol machinery with no original.",
        },
        () => ({
            state: `sint64 ownIndex;\nsint64 zeroIndex;\nsint64 farIndex;\nsint64 mixedIndex;`,
            locals: "sint64 outcome;\nuint16 far;",
            body: `
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, 700, 0);
                locals.far = (uint16)QPI::mod(input.a, 65536ULL);
                state.mut().ownIndex = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
                state.mut().zeroIndex = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, 0, 0);
                state.mut().farIndex = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, locals.far, locals.far);
                state.mut().mixedIndex = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, 0);
            `,
            pairs: [
                [0n, 0n],
                [29n, 0n],
                [65535n, 0n],
            ],
        }),
    ),

    twoOperandArchetype(
        {
            name: "SharesIssueThenBurnToNull",
            family: "assets",
            solidity: `${OZ}/ERC20/ERC20.sol (_burn)`,
            stresses:
                "burning shares by transferring them to NULL_ID, in three steps that together exceed the balance — the point where the burn stops being possible is a return code, not a revert",
        },
        () => ({
            state: `sint64 firstBurn;\nsint64 secondBurn;\nsint64 thirdBurn;\nsint64 remaining;`,
            locals: "sint64 issued;\nsint64 slice;",
            body: `
                locals.issued = qpi.issueAsset(${QAT}ULL, SELF, 0, (sint64)QPI::mod(input.a, 10000ULL), 0);
                locals.slice = QPI::div(locals.issued, (sint64)2) + 1;
                state.mut().firstBurn = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, locals.slice, NULL_ID);
                state.mut().secondBurn = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, locals.slice, NULL_ID);
                state.mut().thirdBurn = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, locals.slice, NULL_ID);
                state.mut().remaining = qpi.numberOfPossessedShares(${QAT}ULL, SELF, SELF, SELF, SELF_INDEX, SELF_INDEX);
            `,
            pairs: [
                [1000n, 0n],
                [1n, 0n],
                [0n, 0n],
            ],
        }),
    ),
];
