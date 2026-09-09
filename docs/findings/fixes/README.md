# Prototyped fixes — what was tested, and what the numbers were

Nothing here is applied to the compiler. Each patch was prototyped in a worktree, run against its
triage repro, then against the compiler unit suite and the 6,618-contract corpus. The numbers below
are measured, not estimated.

Gate used throughout: `bun test packages/compiler/tests/{frontend,edge,qpi,backend,analyzer}` —
**1084 pass / 0 fail** on an unmodified tree.

| patch | repro | unit suite | corpus effect | verdict |
| --- | --- | --- | --- | --- |
| `F220-asset-iterator-selectors.patch` | fixed | 1084 / 0 | 22 pinned rows now report the defect is gone | **ship** |
| `F200-signed-32bit-division.patch` | fixed | 1084 / 0 | +2 rows fixed, 0 broken, all 8 widths clean | **ship** |
| `F213-part1-enclosing-scope-key.patch` | partly fixed | 1084 / 0 | +42 rows fixed, 0 broken | **ship** |
| `F213-both-parts.patch` (adds part 2) | fixed | 1084 / 0 | +55 fixed but **−17 broken** | **do not ship** |
| `F203-k12-address-hardening.patch` | does **not** fix F203 | 1084 / 0 | no change | hardening only |

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

## F221 — not attempted

The ranked option was copy-back after the call. `argAddr` returns only an address, so the call site has
no write path back to the source local; implementing it means restructuring
`emitLibraryCallArgs` to emit post-call writebacks. Not prototyped, so the card's "contained" cost
estimate is unverified.
