# F224 — an iterator in `_locals`, read through its index accessors

    T_BASE=$PWD/corpus/solidity-port/triage/F224-iterator-index-accessors T_NAME=IteratorIndexAccessors \
      bun run scripts/solidity-port/triage-probe.ts

    clang       2 1000 | 27 5 28
    typescript  2 1000 | 27 5 28
    >>> AGREE

Columns are `holders shares | issuanceIdx firstOwnershipIdx lastOwnershipIdx`. The first two are the
control. The three index columns are universe slots: the issuance sits at 27 (SELF's id), the two
ownership records at 5 (`other`, whose id starts with 5) and 28 (SELF's, probed past its issuance).

## What it was

    clang       2 1000 | 2 0 1
    typescript  2 1000 | 0 0 0

`issuanceIndex()` and `ownershipIndex()` are defined inline in `qpi_assets.h` — `return _issuanceIdx;`
— so the TypeScript backend compiled them from source and read fields its `begin()` never wrote.
Silent zeros.

clang's `2 0 1` was not the answer either. Those were a match count and a cursor: core's wasm SDK
took the same snapshot as the TypeScript backend, `lh_assetEnumerate` copying the matches into a
static `assetEntries[1024]`, and stored the two integers in the fields qpi.h documents as universe
indices. Native — the only implementation the doc comments describe — is two live indices and a
`NO_ASSET_INDEX` sentinel.

Since core-lite's wasm ABI v7 both wasm backends resume the native iterator through
`assetIterBegin` / `assetIterNext` / `assetIterRecord`, and the fields carry native's values. That
also closes the two defects the snapshot design hid from every clang-vs-TypeScript row (F226): a walk
stopped silently at 1024 records, and every iterator in a module shared one buffer.

qpi.h says these accessors "should not be used by contracts, because it may change between contract
calls"; the reason this probe still matters is that it is the one place the field contents are
observable from `_locals`.

## Also seen here, and closed with it

- `issuer()` and `assetName()` were not intercepted — `unsupported call as value` — and
  `state.mut().x = locals.iter.issuer()` therefore hit `unsupported aggregate assignment`. Not a
  general aggregate-return gap: once the accessor has an address, the general path copies it.
- `AssetOwnershipIterator it;` at block scope was accepted (clang refuses: the constructor is
  protected) and sized at 8 bytes.
- `AssetOwnershipIterator it(asset, sel);` was parsed as a function declaration.
- `AssetOwnershipIterator it(asset, AssetOwnershipSelect::byOwner(x));` dropped the selector.

Fixed. Pinned in `packages/compiler/tests/differential/asset-iterator-diff.test.ts` and
`clang-refusal-diff.test.ts`.
