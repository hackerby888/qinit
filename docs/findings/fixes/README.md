# Prototyped fixes — what was tested, and what the numbers were

Nothing here is applied to the compiler. Each patch was prototyped in a worktree, run against its
triage repro, then against the compiler unit suite and the corpus. The numbers below are measured,
not estimated.

Gate used throughout: `bun test packages/compiler/tests/{frontend,edge,qpi,backend,analyzer}` —
**1084 pass / 0 fail** on an unmodified tree; **1085 / 0** with the F217 patch, which adds one
toolchain test.

The patches are cumulative in the worktree and were measured stacked, in the order below. Two of them
touch `semantics/struct-layout.ts` (F201 adds a constant F211 uses), so apply F201 before F211.

| patch | repro | unit suite | verdict |
| --- | --- | --- | --- |
| `F220-asset-iterator-selectors.patch` | fixed | 1084 / 0 | **ship** |
| `F200-signed-32bit-division.patch` | fixed | 1084 / 0 | **ship** |
| `F213-part1-enclosing-scope-key.patch` | partly fixed (42 of 55 rows) | 1084 / 0 | **ship** |
| `F210-identity-alias-hang.patch` | fixed — 320ms, was a hang | 1084 / 0 | **ship** |
| `F209-global-scope-qualifier.patch` | fixed | 1084 / 0 | **ship** |
| `F214-sizeof-type-id.patch` | fixed | 1084 / 0 | **ship** |
| `F204-out-of-range-shift-count.patch` | fail-closed by design | 1084 / 0 | **ship** (rejects code that builds today) |
| `F215-member-of-class-prvalue.patch` | fixed | 1084 / 0 | **ship** |
| `F217-block-scope-resolution.patch` | fixed | 1085 / 0 | **ship** (changes 2 tests, deliberately) |
| `F212-read-only-entry-context.patch` | both backends now refuse | 1085 / 0 | **ship** |
| `F201-base-class-alias-chain.patch` | fixed | 1085 / 0 | **ship** |
| `F211-nested-struct-scope.patch` | fixed — crash became a result | 1085 / 0 | **ship** |
| `F221-mutable-reference-write-back.patch` | fixed | 1085 / 0 | **ship** |
| `F222-overload-viability-default-arguments.patch` | fixed (new finding) | 1085 / 0 | **ship** |
| `F213-both-parts.patch` (adds part 2) | fixed | 1084 / 0 | **do not ship** — +55 fixed, **−17 broken** |
| `F203-k12-address-hardening.patch` | does **not** fix F203 | 1084 / 0 | hardening only |

## Corpus effect, all patches stacked

Smoke tier (one contract per archetype, 449 contracts), everything above except the two rejected
patches applied:

```
449 contracts · 437 match · 12 not-match · 0 hang · median 660ms
  0 digest-mismatch   0 trap-divergence   0 harness-error
```

All 12 are accounted for and **none is a new regression**:

| rows | what the harness says | why |
| --- | --- | --- |
| 3 assets | pinned `step-mismatch`, got `match` | F220 fixed |
| 1 controlflow | pinned `one-side-rejected`, got `both-rejected` | F212 — both backends refuse now |
| 5 (hostcalls, layout ×2, namespaces ×2) | pinned `one-side-rejected`, got `match` | F215, F211, F214, F217, F209 fixed |
| 2 (hostcalls, integers) | genuine `step-mismatch` | **F203, still open** — root cause not located |
| 1 namespaces | genuine `step-mismatch` | **F213 part 2, not shipped** |

The nine pinned rows fail *because* the defect is gone; those pins exist to fail that way. They need
unpinning as part of landing any of this. The three real mismatches are the two findings that remain
unfixed, and they were mismatching before these patches too.

## F220 — asset iterator selectors

`begin()` passed `undefined` to `materializeSelect`, which is the branch that builds `any()`. Now each
selector comes from its own argument. `materializeSelect` also takes the select type rather than always
parsing `AssetOwnershipSelect`, so it stays correct if the two structs ever diverge.

Returns a typed `WatNode` instead of a serialised string, which **removes two `rawWatNode` escape
hatches** — the repo's ratchet test (`tests/frontend/ir.test.ts`, cap 32) goes to 30. The first draft
added one instead and failed that test; that is what caught it.

After the fix the three pinned archetypes report
`expected the documented divergence 'step-mismatch' but got 'match'`. That is the harness working as
designed — those rows exist to fail when the defect goes away. **They need unpinning as part of
landing this.**

## F200 — signed 32-bit division

Division was emitted at i64 width regardless of operand type, and `INT32_MIN / -1` is representable at
64 bits, so `i64.div_s` never trapped. Now a signed 32-bit divide wraps to i32, uses `i32.div_s`, and
sign-extends back.

This is the general rule, not a case for one type: C++ promotes anything narrower to `int`, so widths 1
and 2 genuinely do not trap, and width 8 already traps correctly under `i64.div_s`. Width 4 was the only
gap. `MODULO` on the next line had the same defect and moves with it. The corpus sweeps all eight widths
of `DivQpi`; only the two `sint32` rows changed.

## F213 — enum constant resolution

**Part 1 (ship).** `namespace Alpha { enum Level { Low }; }` registered `Alpha::Level::Low`,
`Level::Low` and bare `Low` — but never `Alpha::Low`, the spelling C++ requires for an unscoped enum
member. The qualified read missed and fell back to the bare tail, a flat last-write-wins map. Adding
the enclosing scope fixes **42 of the 55** F213 rows with nothing broken.

**Part 2 (do not ship as written).** The remaining 13 rows are enum-vs-`constexpr`: the bare key
deletes a real file-scope constant. Stopping that fixes them — and **breaks 17 `LogPayloadWithIdField`
rows**, because "constexpr always beats a later enum member" is just the mirror of the original bug.

An earlier draft of part 2 — "first declaration wins" — was worse still: it resolved
`enum E { A = 4, B, C = 9, D }` to **66 and 68**, the ASCII values, because a snapshot enum already
owned the bare keys and the contract's own enum could no longer claim them. The unit suite caught that
one.

The correct rule is scope-aware — nearest declaration wins, equal-scope collision is ambiguous and
should be a diagnostic — and that is a larger change than either draft.

## F203 — not fixed, and the published root cause was wrong

The register said the bug was `emitAddress(...) ?? "(i32.const 0)"` in
`calls/host-intrinsic-call.ts`. Instrumenting that function shows **it is never entered** for
`qpi.K12`. The snapshot carries two definitions of `QpiContextFunctionCall::K12` and qinit's own wins:

```cpp
QPI::id QPI::QpiContextFunctionCall::K12(const T& data) const   // snapshot line 8516
    __lhost_k12(&data, sizeof(T), &digest);
```

So the real path is a library call whose `const T&` parameter has its address taken in the body — the
same shape as F221. Passing every reference by address was tried: **1084 pass, 0 fail, and it fixes
neither F203 nor F221**, so that is not the mechanism either. Root cause is open again.

The patch here is kept only as hardening: it removes the `(i32.const 0)` fallback so the direct
`KangarooTwelve(...)` path cannot hash the bottom of linear memory. It changes no corpus row.

## F221 — fixed, and the published root cause was wrong

The register said `argAddr` hands a mutable `T&` a throwaway scratch copy. The copy is real, and it is
deliberate: a scalar in a wasm local has no address, so a mutable reference to it has to be passed as
one. The defect is that the **read-back after the call** was emitted only when the argument named a
body local — not when it named one of the function's own by-value parameters. qpi.h's
`DateAndTime::add` passes a parameter:

```cpp
if (dayCarry && !addWithoutOverflow(days, dayCarry))   // writes the parameter `days`
    return false;
return add(years, months, days);                        // reads the original `days`
```

The emitted WAT stored `days` into scratch, called through it, and then handed the untouched local to
the date-only overload. `addMillisec(86400000)` therefore advanced the time of day and never the date,
and returned true.

One line of condition, and a parameter is treated as the same kind of storage as a local.
`AddMillisecDayCarry` now reads `1 2024 1 2 0 1 14 752 2` on both backends.

## F222 — a new finding, found while investigating F221

`pickHelperOverload` decided viability with `params.length !== callArguments.length`. An overload whose
trailing parameters carry defaults is therefore non-viable for any call that does not supply all of
them — so for such a call *every* candidate scored -1, and the loop kept its seed: the first-declared
overload. Extra arguments were dropped silently.

A probe of the shape `DateAndTime::add` has — a three-parameter overload beside a
six-required/two-defaulted one — answered **600** for the six-argument call (the three-parameter body)
against clang's **615**.

This does **not** cause F221; that was verified by reverting this patch and re-running the repro, which
still passes. They are two separate defects in the same function.

## F203 — still open

Unchanged from the note above: the published root cause is wrong, the follow-up theory was built and
measured and fixes nothing, and the two corpus rows still mismatch. The patch here is hardening only.
