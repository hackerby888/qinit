# F224 — an asset iterator held in StateData does not match its declared layout

    T_BASE=$PWD/corpus/solidity-port/triage/F224-iterator-in-state T_NAME=IteratorInState \
      bun run scripts/solidity-port/triage-probe.ts

    clang       2 1000 1 | 27 0 0 0 5525825 2 0 0 0 0 16842752 2
    typescript  2 1000 1 | 8589934594 0 0 0 0 0 0 0 0 0 0 0

The first three words are the control and they agree: 2 holders, 1000 shares, 1 call. The walk is
correct on both backends — F220's filter fix is sound and this row is not about it.

The rest is the `Scratch` member holding the iterator. clang's `_issuance` carries SELF's id (slot 27)
and the asset name 5525825 (`QAT`), then the ownership select and the two universe indices. The
TypeScript side carries `8589934594` = `0x2_00000002` — a match count of 2 and a cursor of 2, two
i32s packed into the first word — and zeroes for the remaining ~80 bytes.

That is the whole finding: `emitAssetIter` models an iterator as a transient count and cursor, while
`qpi_asset.h` declares ~88 bytes that clang's `begin()` fills. Invisible in `_locals`; a state-layout
difference the moment the object is a state member.

Not fixed. Both backends already size the iterator at 96 bytes — `sizeOfType` reads qpi.h's class — so
this is a fill, not a layout move. See `F224-iterator-index-accessors` for the same finding on a
contract that keeps its iterator in `_locals`, and for why the fields cannot simply be written.
