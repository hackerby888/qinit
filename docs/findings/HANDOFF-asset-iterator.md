# Handoff — the asset iterator

Nine defects found while chasing F224. Six are qinit's alone, two are shared with core's wasm SDK, one
is core's. This is an orientation document: it says what each thing is and what a fix would look like,
not how to write it.

## The thing to understand first

There are **three** implementations of `AssetOwnershipIterator` / `AssetPossessionIterator`, not two.

| | where | design |
| --- | --- | --- |
| **A. native core** | `core/src/qpi/impl/qpi_assets_impl.h:110` | the iterator *is* two live universe indices; every accessor reads `assets[]` at `_issuanceIdx` / `_ownershipIdx`, and `next()` hops to the next matching slot |
| **B. core's wasm SDK** | `core/src/extensions/wasm/sdk/qpi_support.h:261` | snapshot: `lh_assetEnumerate` bulk-copies matches into `assetEntries[1024]`; `_issuanceIdx` holds the **match count** and `_ownershipIdx` a **dense cursor** |
| **C. qinit** | `packages/compiler/src/backend/wasm/calls/containers.ts:516` (`emitAssetIter`) | the same snapshot design as B — but the count and cursor go to raw offsets **0 and 4**, the declared fields are never written, and records come from the `$assetIterBase` global |

Two consequences people get wrong:

- **B is what our clang oracle compiles**, not A. `CORE_WASM_HEADERS.sdk.qpiSupport` → `sdk/qpi_support.h`.
  So when a probe prints clang's `2 0 1`, that is *match count 2, cursor 0, cursor 1* — **not** universe
  indices.
- **B and C are the same design.** The gap between them is only *where two integers live*. That is why
  F224 is a small fix and not a host-ABI change.

The host side is also worth knowing: `enumerateAssets` (`core/src/extensions/wasm/runtime/qpi_services.h:25`)
runs **native's own iterator** and marshals the results across the sandbox boundary. B is a marshalling
layer, not a second algorithm.

## Defects

### qinit's alone — measured, no dependency on core

| # | what | evidence |
| --- | --- | --- |
| 1 | **F224.** The declared fields are never written. An iterator in `StateData` is 96 bytes on both sides, with ~88 left unwritten in qinit → state-digest divergence. | `corpus/solidity-port/triage/F224-iterator-in-state/` |
| 2 | `issuanceIndex()` / `ownershipIndex()` return **0**. They are defined *inline* in `qpi_assets.h`, so they compile from source and read the fields #1 never writes. clang `2 0 1`, qinit `0 0 0`. Silent. | `corpus/solidity-port/triage/F224-iterator-index-accessors/` |
| 3 | `issuer()` and `assetName()` are missing from `emitAssetIter`'s method list → `unsupported call as value`. They are defined *out of line*, so the backend must intercept them. clang compiles. | probe |
| 4 | `state.x = iter.issuer()` → `unsupported aggregate assignment` (`aggregate-assignment.ts:42`). An aggregate returned by value has no address, so `emitAddress` fails and it falls through. Probably **not iterator-specific**. | probe |
| 5 | `AssetOwnershipIterator it;` — **qinit accepts what clang rejects** (the default ctor is `protected`, `qpi_assets.h:128`). qinit allocates 8 bytes (`declaration-statement.ts:37`) and `issuanceIndex()` then reads offset 40 → out of bounds (`16842752` = `0x01010100`). | probe |
| 6 | `AssetOwnershipIterator it(asset, sel);` — the legal block-scoped form — is a **parse error** in qinit; it is read as a function declaration. clang compiles it. | probe |

Note on sizing: `sizeOfType` has a `return 8` fallback for these types (`type-resolver.ts:48`) and
`declaration-statement.ts:37` allocates 8 bytes, but **every legal placement is a struct member**, which
goes through `layoutOfStruct` → 96 bytes. The 8-byte path is reachable only via #5. clang tolerates
`AssetOwnershipIterator iter;` as a struct member because the locals struct is raw `__qpiAllocLocals`
memory that is never constructed, so the access check never fires.

### Shared with core's wasm SDK — read from code, NOT yet measured

| # | what |
| --- | --- |
| 7 | **Silent truncation at 1024.** `WASM_ASSET_ENTRY_CAPACITY` is 1024 (`core/src/extensions/wasm/shared/abi_types.h:20`). The host stops at `count < capacity` and returns `count` with no overflow signal; qinit mirrors this at `packages/engine/src/contract/runtime.ts:1136` (`Math.min(entries.length, maxN)`). Native has no limit. |
| 8 | **One shared snapshot buffer per module.** core: `assetEntries[]` at `qpi_support.h:258`; qinit: the single `$assetIterBase` global. Every `begin()` fills it from index 0, so two live iterators silently overwrite each other's records. |

**Both are invisible to the two-backend harness** — qinit and core's wasm SDK make the same mistake, so
the two legs agree and the sweep stays green. Only native, or a WAMR oracle with `assetEnumerate`
shimmed, can see them.

Worked case for #7: `core/src/contracts/QUtil.h:1861`, `DistributeQuToShareholders`. Both its loops
truncate, so `totalShares` is undercounted, `amountPerShare` is inflated, the first 1024 holders are
overpaid, the rest get nothing — and `ASSERT(payBack >= 0)` still holds, because both terms came from
the same truncated total. No trap, no error, wrong distribution.

#8 needs no unusual scale to trigger: an inner `begin()` inside an outer walk is ordinary code. No core
contract hits it today (`TestExampleA.h:488` nests, but its outer `AssetIssuanceIterator` is not
implemented in the wasm SDK at all).

### core's alone — read from code

| # | what |
| --- | --- |
| 9 | Native and core's wasm SDK disagree about what `_issuanceIdx` / `_ownershipIdx` mean, and the wasm side loses the `NO_ASSET_INDEX` sentinel — both contradicting the doc comments on the accessors that return them. qpi.h does say *"Should not be used by contracts, because it may change between contract calls."* |

## What the fixes could be

**#1, #2 — mirror `qpi_support.h`.** In `emitAssetIter`'s `begin()`, write the enumerate result into
`_issuanceIdx`'s declared offset and 0 into `_ownershipIdx`'s, and copy `_issuance` and
`_ownership`(/`_possession`) — all three values are already materialised in that function. Point
`next()` and `reachedEnd()` at the same offsets. **This fixes #2 for free**, because those accessors are
inline reads of the fields we would start writing. No host-ABI change, no layout move, no decision to
make — core's own wasm SDK already does exactly this.

**#3** — add the two methods to `emitAssetIter`'s intercept list.

**#4** — likely wants a general path for assigning an aggregate returned by value; check whether it is
iterator-specific before scoping it here.

**#5** — fail closed: reject the declaration clang rejects, rather than allocating 8 bytes and reading
past it.

**#6** — parser: disambiguate the declaration from a function declaration.

**#7, #8 — core's ABI, and core moves first.** Three shapes:

- *Page the snapshot* — keep the buffer, fetch the next 1024 when the cursor runs out. Cheap; loses the
  single-snapshot atomicity, so a mutation mid-loop can skip or duplicate.
- *Stateless per-record resume* — drop the buffer; `next()` becomes
  `nextOwnership(issuance, select, fromIdx) → (idx, record)`. Fixes **#7, #8 and #9 together**, and
  restores the declared fields to their documented meaning. Costs one host call per record instead of
  one per loop, inherits native's mutation-during-iteration semantics, and the possession iterator needs
  a resume *pair*, which is the fiddly part.
- *Keep the cap, make it loud* — trap or error on overflow. Does not match native, but turns a silent
  wrong answer into a visible failure. Cheapest, and worth doing whichever of the other two eventually
  lands.

Raising the cap is not an option: the buffer is static memory inside the contract's wasm linear memory,
so "unlimited" would be 80 bytes × `ASSETS_CAPACITY` = **1.34 GB** per contract on mainnet (`ASSETS_DEPTH`
24; 21 MB on LITE at depth 18).

qinit must not move ahead of core on #7/#8 — if our host call changes while core's SDK still bulk
enumerates, qinit-built contracts behave differently from core-built ones, which is worse than the bug.
When it does follow, six areas move: `emitAssetIter` and ~8 other compiler sites, the `$assetIterBase`
layout and its ~2 pages (`framework-types.ts:100-102`), the engine host binding and the
`ownershipIndices`/`possessionIndices` walk helpers (`packages/engine/src/ledger/assets.ts:240-317` — the
real cost, two traversal orders neither monotonic in raw index), the WAMR shim, the ABI metadata, and
the fixtures.

## Reproducing

```
QINIT_CORE=/path/to/core-lite \
WASM_CLANG=.../bin/clang++ WASI_SYSROOT=.../share/wasi-sysroot \
T_BASE=$PWD/corpus/solidity-port/triage/F224-iterator-index-accessors \
T_NAME=IteratorIndexAccessors \
bun run scripts/solidity-port/triage-probe.ts
```

`T_BASE` must be absolute. State prints as little-endian u64 words, one per `StateData` field.

For #7 and #8 the clang leg is **not** a useful oracle — it shares the defect. Use native, or shim
`assetEnumerate` into core-lite's WAMR gtest (the parity shim now lives in
`core/test/wasm_contracts.cpp` and `core/test/wasm_k12_shim.cpp`; `assetEnumerate` is deliberately
absent from it).

## Open questions

- Is #4 general, or iterator-specific?
- Do #7 and #8 actually reproduce? Both are code-read only. #8 is cheap to demonstrate (two assets, a
  nested loop); #7 needs >1024 ownership records, or a unit test against the engine's host binding
  rather than a compiled contract.
- Does any live Qubic asset exceed 1024 ownership records? That decides #7's real severity.
- For #7/#8, should qinit match core's wasm SDK or native? They are not the same target, and the answer
  is a decision about qinit's relationship to core rather than a compiler question.

## Stale text to fix when touching this

- `docs/findings/TESTING-FINDINGS-9-solidity-port.md` still describes F224 as needing an ABI change and
  does not mention implementation **A** vs **B** at all.
- `corpus/solidity-port/triage/F224-iterator-index-accessors/NOTES.md` calls clang's `2 0 1` "universe
  indices" (it is a match count and a cursor) and calls itself "the realistic face" (it rests on
  accessors qpi.h tells contracts not to use).
