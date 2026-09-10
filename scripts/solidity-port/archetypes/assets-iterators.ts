// The asset iterators and selectors — the half of the asset API the corpus has never called.
//
// Round 6's inventory found the corpus calling exactly four asset functions (`issueAsset`,
// `numberOfPossessedShares`, `transferShareOwnershipAndPossession`, `isAssetIssued`) across 42 asset
// archetypes and 380 contracts. Never called: every selector (`AssetIssuanceSelect`,
// `AssetOwnershipSelect`, `AssetPossessionSelect`), every iterator (`AssetIssuanceIterator`,
// `AssetOwnershipIterator`, `AssetPossessionIterator`), `numberOfShares` in its selector form, and
// `distributeDividends`. That mattered because F69 (campaign 6) and F82 (campaign 7) were both in
// share management, which this corpus has never exercised.
//
// The lead archetype here was written from a divergence found by reading the backend rather than by
// sweeping: `begin` lowered one `any()` selector and passed that same buffer for BOTH the ownership
// and the possession parameter of `$lh_assetEnumerate`, never reading callArguments[1] or [2], so a
// filtered walk silently enumerated everything while clang honoured the filter. That is fixed — each
// selector now comes from its own argument — and these rows hold it fixed.
//
// Asset state lives in the host's ledger, not in StateData, so the K12 digest cannot see it directly
// (assets-shares.ts:1-12 makes the same point). Every archetype below therefore mirrors what it reads
// back into its own uint64 members, which is what puts the difference in front of the comparator.
import { emitContract } from "../emit";
import { u64 } from "../encode";
import { describeAxis, script } from "./common";
import type { Archetype, AxisAssignment, BuiltContract, CallStep } from "../types";

const OZ = "openzeppelin-contracts/contracts/token";

/** An asset name as QPI encodes it: up to seven ASCII bytes, little-endian, in a uint64. */
function assetName(text: string): bigint {
    let value = 0n;
    for (let index = text.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(text.charCodeAt(index));
    return value;
}

const QAT = assetName("QAT");

interface IterProbeSpec {
    state: string;
    body: string;
    locals: string;
    pairs: [bigint, bigint][];
}

/** One `Probe` procedure driven by two uint64 operands, and a `Read` that mirrors state back out. */
function iterProbe(meta: Omit<Archetype, "build">, spec: (axis: AxisAssignment) => IterProbeSpec): Archetype {
    return {
        ...meta,
        build(axis: AxisAssignment): BuiltContract {
            const shape = spec(axis);
            const members = shape.state
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .map((line) => line.replace(/;$/, "").split(/\s+/).slice(-1)[0]!);
            const readBack = `${shape.state.trim()}\nuint64 calls;`;
            const source = emitContract({
                axis,
                name: meta.name,
                header: {
                    archetype: meta.name,
                    family: meta.family,
                    solidity: meta.solidity,
                    stresses: meta.stresses,
                    caveat: meta.caveat,
                    axis: describeAxis(axis),
                },
                state: readBack,
                entries: [
                    {
                        name: "Probe",
                        kind: "procedure",
                        number: 1,
                        input: "uint64 a;\nuint64 b;",
                        locals: shape.locals,
                        body: `${shape.body}\nstate.mut().calls++;`,
                    },
                    {
                        name: "Read",
                        kind: "function",
                        number: 1,
                        output: readBack,
                        body: [...members.map((m) => `output.${m} = state.get().${m};`), "output.calls = state.get().calls;"].join("\n"),
                    },
                ],
                initialize: [...members.map((m) => `state.mut().${m} = 0;`), "state.mut().calls = 0;"].join("\n"),
            });
            const steps: CallStep[] = [];
            for (const [a, b] of shape.pairs) {
                steps.push({ kind: "procedure", entry: 1, in: u64(a) + u64(b), invocator: 0, note: `${a} , ${b}` });
                steps.push({ kind: "function", entry: 1 });
            }
            steps.push({ kind: "advanceTick", n: 1 });
            return { source, script: script(steps) };
        },
    };
}

export const ASSET_ITERATOR_ARCHETYPES: Archetype[] = [
    iterProbe(
        {
            name: "AssetOwnershipIteratorOwnerFilterIgnored",
            family: "assets",
            solidity: `${OZ}/ERC20/extensions/ERC20Snapshot.sol (per-holder balance enumeration)`,
            stresses:
                "an AssetOwnershipIterator opened with AssetOwnershipSelect::byOwner — the filter is accepted, compiles and runs, and the walk it produces is compared against the same walk opened with any()",
            caveat:
                "The Solidity original enumerates a mapping it controls; QPI enumerates the host's ledger, so the port mirrors what it reads into state to make the difference visible to a state digest.",
            // No `temporaries` axis: it moves every temporary into StateData, and an iterator there is
            // digested. The backend models an iterator as a transient count+cursor, not the ~88-byte QPI
            // class clang fills, so those bytes cannot agree — a separate finding, and not a shape a
            // contract would write.
            axes: ["placement"],
        },
        () => ({
            state: "uint64 filteredCount;\nuint64 filteredShares;\nuint64 unfilteredCount;\nuint64 unfilteredShares;",
            locals: "id other;\nAsset asset;\nAssetOwnershipIterator iter;\nuint64 guard;\nsint64 outcome;",
            body: `
                locals.other = id(input.a, 0, 0, 0);
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, 1000, 0);
                locals.outcome = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, input.b, locals.other);
                locals.asset.issuer = SELF;
                locals.asset.assetName = ${QAT}ULL;

                locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.other));
                locals.guard = 0;
                while (!locals.iter.reachedEnd() && locals.guard < 16)
                {
                    state.mut().filteredCount++;
                    state.mut().filteredShares += locals.iter.numberOfOwnedShares();
                    locals.iter.next();
                    locals.guard++;
                }

                // The same walk with no filter, as the control that separates "the filter was
                // dropped" from "the iteration is broken".
                locals.iter.begin(locals.asset, AssetOwnershipSelect::any());
                locals.guard = 0;
                while (!locals.iter.reachedEnd() && locals.guard < 16)
                {
                    state.mut().unfilteredCount++;
                    state.mut().unfilteredShares += locals.iter.numberOfOwnedShares();
                    locals.iter.next();
                    locals.guard++;
                }
            `,
            pairs: [[5n, 400n]],
        }),
    ),

    iterProbe(
        {
            name: "AssetPossessionIteratorPossessorFilterIgnored",
            family: "assets",
            solidity: `${OZ}/ERC721/extensions/ERC721Enumerable.sol (enumerate by holder)`,
            stresses:
                "the possession iterator's two-selector begin(), where the ownership and possession filters are separate arguments — the lowering passes one buffer for both, so this asks whether either survives",
            caveat: "ERC721Enumerable indexes tokens per owner in its own storage; the QPI analogue is a host-side ledger walk.",
            // No `temporaries` axis: it moves every temporary into StateData, and an iterator there is
            // digested. The backend models an iterator as a transient count+cursor, not the ~88-byte QPI
            // class clang fills, so those bytes cannot agree — a separate finding, and not a shape a
            // contract would write.
            axes: ["placement"],
        },
        () => ({
            state: "uint64 filteredCount;\nuint64 filteredShares;\nuint64 unfilteredCount;",
            locals: "id other;\nAsset asset;\nAssetPossessionIterator iter;\nuint64 guard;\nsint64 outcome;",
            body: `
                locals.other = id(input.a, 0, 0, 0);
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, 1000, 0);
                locals.outcome = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, input.b, locals.other);
                locals.asset.issuer = SELF;
                locals.asset.assetName = ${QAT}ULL;

                locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.other), AssetPossessionSelect::byPossessor(locals.other));
                locals.guard = 0;
                while (!locals.iter.reachedEnd() && locals.guard < 16)
                {
                    state.mut().filteredCount++;
                    state.mut().filteredShares += locals.iter.numberOfPossessedShares();
                    locals.iter.next();
                    locals.guard++;
                }

                locals.iter.begin(locals.asset, AssetOwnershipSelect::any(), AssetPossessionSelect::any());
                locals.guard = 0;
                while (!locals.iter.reachedEnd() && locals.guard < 16)
                {
                    state.mut().unfilteredCount++;
                    locals.iter.next();
                    locals.guard++;
                }
            `,
            pairs: [[7n, 250n]],
        }),
    ),

    iterProbe(
        {
            name: "AssetOwnershipIteratorSurvivesEmptyFilter",
            family: "assets",
            solidity: `${OZ}/ERC20/ERC20.sol (enumerating a holder with no balance)`,
            stresses:
                "a filter naming an id that holds none of the asset — under a lowering that honours filters the walk is empty, and under one that discards them it returns every holder, so the two answers are maximally far apart",
            caveat: "Chosen so the expected result is zero rather than a count: an empty walk is the least ambiguous evidence that a filter was applied at all.",
            // No `temporaries` axis: it moves every temporary into StateData, and an iterator there is
            // digested. The backend models an iterator as a transient count+cursor, not the ~88-byte QPI
            // class clang fills, so those bytes cannot agree — a separate finding, and not a shape a
            // contract would write.
            axes: ["placement"],
        },
        () => ({
            state: "uint64 strangerCount;\nuint64 strangerShares;\nuint64 holderCount;",
            locals: "id holder;\nid stranger;\nAsset asset;\nAssetOwnershipIterator iter;\nuint64 guard;\nsint64 outcome;",
            body: `
                locals.holder = id(input.a, 0, 0, 0);
                locals.stranger = id(input.b, 0, 0, 0);
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, 1000, 0);
                locals.outcome = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, 300, locals.holder);
                locals.asset.issuer = SELF;
                locals.asset.assetName = ${QAT}ULL;

                locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.stranger));
                locals.guard = 0;
                while (!locals.iter.reachedEnd() && locals.guard < 16)
                {
                    state.mut().strangerCount++;
                    state.mut().strangerShares += locals.iter.numberOfOwnedShares();
                    locals.iter.next();
                    locals.guard++;
                }

                locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.holder));
                locals.guard = 0;
                while (!locals.iter.reachedEnd() && locals.guard < 16)
                {
                    state.mut().holderCount++;
                    locals.iter.next();
                    locals.guard++;
                }
            `,
            pairs: [[11n, 12n]],
        }),
    ),

    iterProbe(
        {
            name: "AssetNumberOfSharesWithSelectors",
            family: "assets",
            solidity: `${OZ}/ERC20/ERC20.sol (totalSupply versus balanceOf)`,
            stresses:
                "qpi.numberOfShares in its selector form — the counting counterpart of the iterators, and the only asset query that takes an AssetOwnershipSelect and an AssetPossessionSelect directly rather than through an iterator",
            caveat:
                "No expect rows: whether the selectors reach the host at all is the open question this archetype exists to answer, so pinning an expected number would presume it.",
            axes: ["placement", "temporaries"],
        },
        () => ({
            state: "uint64 total;\nuint64 byHolder;\nuint64 byStranger;",
            locals: "id holder;\nid stranger;\nAsset asset;\nsint64 outcome;",
            body: `
                locals.holder = id(input.a, 0, 0, 0);
                locals.stranger = id(input.b, 0, 0, 0);
                locals.outcome = qpi.issueAsset(${QAT}ULL, SELF, 0, 1000, 0);
                locals.outcome = qpi.transferShareOwnershipAndPossession(${QAT}ULL, SELF, SELF, SELF, 400, locals.holder);
                locals.asset.issuer = SELF;
                locals.asset.assetName = ${QAT}ULL;

                state.mut().total = qpi.numberOfShares(locals.asset);
                state.mut().byHolder = qpi.numberOfShares(locals.asset, AssetOwnershipSelect::byOwner(locals.holder));
                state.mut().byStranger = qpi.numberOfShares(locals.asset, AssetOwnershipSelect::byOwner(locals.stranger));
            `,
            pairs: [[5n, 6n]],
        }),
    ),
];
