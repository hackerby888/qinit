# F224 — an asset iterator held in StateData does not match its declared layout

    T_BASE=$PWD/corpus/solidity-port/triage/F224-iterator-in-state T_NAME=IteratorInState \
      bun run scripts/solidity-port/triage-probe.ts

    clang       2 1000 1 | 27 0 0 0 5525825 27 0 0 0 0 16842752 4294967295
    typescript  2 1000 1 | 27 0 0 0 5525825 27 0 0 0 0 16842752 4294967295
    >>> AGREE

The first three words are the control: 2 holders, 1000 shares, 1 call. The rest is the `Scratch`
member holding the iterator: `_issuance` (SELF's id, slot 27, and the asset name 5525825 `QAT`),
`_issuanceIdx` (the issuance's universe slot, 27), the ownership select (`any()`: the two flag bytes
in `16842752`), and `_ownershipIdx`, which is `NO_ASSET_INDEX` once the walk has ended.

## What it was

    clang       2 1000 1 | 27 0 0 0 5525825 2 0 0 0 0 16842752 2
    typescript  2 1000 1 | 8589934594 0 0 0 0 0 0 0 0 0 0 0

`emitAssetIter` modelled the iterator as a match count at offset 0 and a cursor at offset 4, packed
into the first word (`8589934594` = `0x2_00000002`), and never wrote the rest. Invisible in `_locals`;
a state-layout difference the moment the object is a state member.

clang's `2 … 2` was not the native layout either: core's wasm SDK had the same snapshot design, with
the count in `_issuanceIdx` and the cursor in `_ownershipIdx`. Both are gone with core-lite's wasm ABI
v7: the object holds the native iterator's universe indices and the host advances them in place. See
`F224-iterator-index-accessors` for the accessors that read those fields, and F226 in
`docs/findings/TESTING-FINDINGS-9-solidity-port.md` for the 1024-record cap and the shared buffer the
snapshot design carried.

Fixed. Pinned as the first object row of `packages/compiler/tests/differential/asset-iterator-diff.test.ts`.
