# F220 — `AssetOwnershipIterator::begin` discards its selector arguments

Severity: **high**. Silent wrong answer, no diagnostic, in code that counts other people's shares.

## What happens

`packages/compiler/src/backend/wasm/calls/containers.ts:523`:

```ts
const selN = watIr.rawWatNode(context.lowering.materializeSelect(context, undefined), WatNodeType.I32);
```

`materializeSelect` is called with `undefined`, which makes it build the `any()` selector, and that one
buffer is then passed for **both** the ownership and the possession parameter of `$lh_assetEnumerate`.
`expression.callArguments[1]` and `[2]` — the selectors the contract actually wrote — are never read.
Only `callArguments[0]`, the asset, survives.

clang compiles core's real `AssetOwnershipIterator`, which honours the filter. So the two backends
disagree on a value, not on a refusal.

## Reproducing

```sh
export QINIT_CORE=/path/to/core-lite
bun run scripts/solidity-port/wamr-probe.ts \
    corpus/solidity-port/triage/F220-asset-iterator-filter/AssetIterFilter.h AssetIterFilter 29 1:0000000000000000
```

Or drive both backends through the simulator directly and read the `Read` function's output. The
contract issues 1000 shares, transfers 400 to a second id, then walks the ownership iterator twice —
once filtered to that id, once unfiltered.

| field | clang | typescript |
| --- | --- | --- |
| `filteredCount` | 1 | **2** |
| `filteredShares` | 400 | **1000** |
| `unfilteredCount` | 2 | 2 |
| `unfilteredShares` | 1000 | 1000 |

**The unfiltered walk is the control.** It agrees on both backends, which is what shows the divergence
is the discarded filter rather than anything about iteration, enumeration capacity, or the ledger.

## Scope

The defect is specific to the iterator's `begin()`. The same selector machinery is correct when it is
handed a real expression: `qpi.numberOfShares(asset, AssetOwnershipSelect::byOwner(holder))` returns
1000 / 400 / 0 for total / holder / stranger on **both** backends. So this is not "selectors are
unsupported" — it is one call site passing `undefined` where it should pass its argument.

Nearby in the same function, and not separately triaged:

- `begin` passes the ownership buffer for the possession parameter too, so even a correct ownership
  filter would leave the possession filter wrong.
- `emitAssetIter` returns `null` — falling through to whatever handles an unrecognised call — for
  `issuer()`, `assetName()`, `asset()`, `issuanceIndex()`, `ownershipIndex()`, `possessionIndex()` and
  `possessionManagingContract()`.
- The type gate at `:508` accepts only `AssetOwnershipIterator` and `AssetPossessionIterator`;
  `AssetIssuanceIterator` is not recognised at all.

## Why it went unseen for seven rounds

The corpus called exactly four asset functions — `issueAsset`, `numberOfPossessedShares`,
`transferShareOwnershipAndPossession`, `isAssetIssued` — across 42 asset archetypes and 380 contracts.
Every selector and every iterator was at zero call sites. This was found by reading the backend, then
confirmed by writing the first contract that had ever called `begin()` with a filter.

## Corpus rows

`assets/AssetOwnershipIteratorOwnerFilterIgnored__*`,
`assets/AssetPossessionIteratorPossessorFilterIgnored__*`,
`assets/AssetOwnershipIteratorSurvivesEmptyFilter__*` — all pinned through `expectedVerdict:
"step-mismatch"`, so they are regression rows: if the lowering is fixed they turn red and say so.
