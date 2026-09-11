# F224, the realistic face — an iterator in `_locals`, read through its index accessors

    T_BASE=$PWD/corpus/solidity-port/triage/F224-iterator-index-accessors T_NAME=IteratorIndexAccessors \
      bun run scripts/solidity-port/triage-probe.ts

    clang       2 1000 | 2 0 1
    typescript  2 1000 | 0 0 0

Columns are `holders shares | issuanceIdx firstOwnershipIdx lastOwnershipIdx`. The first two are the
control and they agree: the walk itself is correct on both backends. The three index columns are the
finding — clang reports the issuance at universe index 2 and the two ownership records at 0 and 1;
the TypeScript backend reports zero for all three, silently.

This matters because the companion repro (`F224-iterator-in-state`) only diverges with the iterator
held in `StateData`, which no contract would write. Here the iterator is an ordinary `_locals` member
and the divergence is still there, through two accessors a contract may legitimately call.

## Why these two accessors and not the others

`qpi_assets.h` splits the iterator's interface in half, and the halves fail differently.

`issuanceIndex()` and `ownershipIndex()` are **defined inline in the class body** — `return
_issuanceIdx;`. The TypeScript backend compiles them from source like any member function, reads the
declared field at its declared offset, and finds the zero that `emitAssetIter`'s `begin()` left there.
Wrong answer, no diagnostic.

`issuer()`, `assetName()`, `owner()`, `numberOfOwnedShares()` and `ownershipManagingContract()` are
**declared in the class and defined out of line** (`qpi/impl/qpi_assets_impl.h:208-236`), so the
backend has to intercept them. `emitAssetIter` intercepts four; `issuer()` and `assetName()` it does
not, and a contract calling either is rejected rather than answered wrongly:

    error: unsupported call as value [locals.iter.assetName(0)]

## What the finding actually is

Not "`begin()` forgot to fill some fields". The two backends implement **different iterators**.

clang's iterator *is* the two indices: every out-of-line accessor is a lookup into the live asset
universe at `_issuanceIdx` / `_ownershipIdx`, and `next()` advances `_ownershipIdx` to the next
matching universe slot. The declared fields are the whole mechanism.

The TypeScript backend takes a snapshot instead: `$lh_assetEnumerate` copies matching records into
`$assetIterBase`, and the iterator is a match count at offset 0 and a dense cursor at offset 4. Its
accessors read the snapshot, so they are right; the declared fields are never needed, so they are
never written — and the two accessors that read them directly report zero.

That is also why filling the layout is not a local change. `AssetEntry` (`packages/engine/src/ledger/
assets.ts:37`) carries `owner, possessor, shares, ownMgmt, posMgmt` and no universe index, and
`$lh_assetEnumerate` returns a match count, so the indices are not available to write. And the cursor
currently occupies offset 4, which is inside `_issuance.issuer` — filling `_issuance` displaces it.

## Also seen here, and not F224

Storing an `id`-returning accessor into state is rejected outright:

    error: unsupported aggregate assignment [state.mut(0).iterIssuer = locals.iter.issuer(0)]

clang compiles it. That is a one-side-rejected in its own right, unrelated to the iterator's layout —
it is about assigning an aggregate returned by value — and it is not tracked by any finding yet.
