# qinit test campaign 9 — Solidity-ported contracts, TypeScript compiler vs clang (F200+)

Harness: `scripts/solidity-port/`. Corpus: `corpus/solidity-port/` (generated; owned by
`scripts/solidity-port/generate.ts`). Controls: `packages/compiler/tests/differential/solidity-port.test.ts`.

Qinit HEAD `bf53045` (2026-09-07). core-lite `develop` @ `0397da159a72c2c3e56790dbe33e53b0ca3bea51`,
used as `QINIT_CORE`. wasi-sdk-29, `clang version 21.1.4-wasi-sdk`. Bun 1.3.11 (repo pins 1.3.14).
Linux 6.18.44 x86_64, 4 CPUs, 15 GB RAM. Runtime: the in-process `QubicSimulator`, not a live node.

Findings number from **F200**. The ledger stops at F85 and `docs/testing-macos-handoff.md` reserves
F86 onward for the macOS campaign, so F86–F199 are left to it.

Report only; nothing in Qinit or core-lite was changed.

## What this campaign is

Every existing differential suite in this repo is a hand-written probe: someone thought of a case and
checked it. This one imports an adversarial corpus nobody here designed — 68 archetypes hand-ported
from tricky Solidity, expanded along axes that have historically produced silent bugs in this compiler,
into 605 contracts. Each is compiled by **both** backends, executed on a byte-identical call script in
the same simulator, and compared by the **K12 digest of its final contract state**.

Sources for the archetypes: [`ethereum/solidity`](https://github.com/ethereum/solidity)
`test/libsolidity/semanticTests` (1,682 self-contained tests, each with an embedded call script and
expected results), [`crytic/not-so-smart-contracts`](https://github.com/crytic/not-so-smart-contracts)
(25 vulnerability archetypes), and OpenZeppelin's ERC20 / Ownable / Pausable.

## Summary

- **2 confirmed defects**, both in the TypeScript backend, both with controls inside the repro contract:
  - **F200** — `QPI::div` on `sint32` at `INT32_MIN / -1`: clang traps, the TypeScript backend returns
    `INT32_MIN` and keeps executing. **Silent divergence from what the chain does.**
  - **F201** — a member read through a base class reached by a three-deep alias chain is rejected by the
    TypeScript backend and accepted by clang. Loud rejection of legal C++.
- **1 harness defect, found and fixed during the campaign** (F202, recorded because it is the reason a
  green run was briefly not green): the generator's `placement=nested` rewrite also rewrote the guard
  member that deliberately sits outside the nested struct.
- **601 of 605 contracts agree byte-for-byte** on the final state digest; the 4 that do not are the
  two findings (three `sint32` variants for F200, one `aliasOfAlias` variant for F201).
- Both findings are **width- or depth-specific**, and were invisible at the plain spelling. Neither
  would have been produced by a probe someone sat down to write.

## Findings

### F200 — `QPI::div(sint32, sint32)` at `INT32_MIN / -1` traps under clang and silently wraps under the TypeScript backend

Severity: **high (silent divergence from on-chain behaviour: a contract that halts on the real node
keeps running, with a wrong quotient, under `--compiler typescript`)**.

Repro: `corpus/solidity-port/triage/F200-sint32-div-overflow/` (`DivOverflow.h`, `script.json`,
`control-sint64.json`).

```
export QINIT_CORE=… WASM_CLANG=…/bin/clang++ WASI_SYSROOT=…/share/wasi-sysroot
d=corpus/solidity-port/triage/F200-sint32-div-overflow
bun run scripts/solidity-port/triage.ts $d/DivOverflow.h $d/script.json
# DivOverflow: trap-divergence — step count 4 != 3
# TypeScript backend:
#   status ok  digest 786a3019b2e451a2…  stateSize 24
#   [ 0] procedure 1  out 00
#   [ 1] function 1  out fdffffffffffffff 0000000000000000 0100000000000000     <- control: -6/2 = -3
#   [ 2] procedure 1  out 00                                                    <- INT32_MIN / -1: no trap
#   [ 3] function 1  out 00000080ffffffff 0000000000000000 0200000000000000     <- result32 = -2147483648
# clang backend:
#   status trap  digest 12cb76febc386b6b…  stateSize 24
#   [ 0] procedure 1  out 00
#   [ 1] function 1  out fdffffffffffffff 0000000000000000 0100000000000000     <- same control value
#   [ 2] procedure 1  FAULT engine faulted: Integer overflow
exit 1
```

The contract's body is one line: `locals.quotient = QPI::div(input.a, input.b);` with
`sint32 quotient`. Driven with `a = INT32_MIN (0x80000000)`, `b = -1`.

Oracle: wasm's `i32.div_s` is defined to trap when the quotient is not representable, which is exactly
`INT32_MIN / -1` (WebAssembly core spec, `idiv_s`). clang emits that instruction and the engine reports
`engine faulted: Integer overflow`. Since clang is what core builds contracts with, **clang's trap is
what the chain does**; the TypeScript backend not trapping is the defect. Its answer, `-2147483648`, is
the x86 wrap, which the wasm instruction deliberately does not produce.

Controls, both in the same repro:

| row | TypeScript | clang |
| --- | --- | --- |
| `sint32 -6 / 2` (ordinary signed division) | `-3` | `-3` — agree, so `QPI::div` itself is not implicated |
| `sint64 INT64_MIN / -1` (`control-sint64.json`) | traps, digest `c501bf78…` | traps, digest `c501bf78…` — **identical**, so the 64-bit path is correct |
| `sint32 INT32_MIN / -1` | no trap, `-2147483648` | traps | 

The width sweep across the whole corpus makes the boundary exact — of 24 `DivQpi` variants, **only the
three `sint32` ones diverge**:

```
match            integers/DivQpi__55a8   {'width': 'sint8'}     <- promotes to int; -128/-1 = 128, no overflow
match            integers/DivQpi__c12b   {'width': 'sint16'}    <- same
trap-divergence  integers/DivQpi__209b   {'width': 'sint32', 'placement': 'first'}
trap-divergence  integers/DivQpi__6157   {'width': 'sint32', 'placement': 'last'}
trap-divergence  integers/DivQpi__6bd4   {'width': 'sint32', 'placement': 'nested'}
match            integers/DivQpi__3bce   {'width': 'sint64'}    <- both trap
```

`sint8` and `sint16` agree because C++ integer promotion widens both operands to `int` before the
division, so the quotient is representable and nothing traps. `sint64` agrees because both backends
emit the trapping 64-bit divide. The gap is `sint32` only: the one width where the operands are already
`int` and the TypeScript backend appears to compute the division wider than 32 bits.

### F201 — a member read through a three-deep alias chain to a base class is rejected by the TypeScript backend and accepted by clang

Severity: **medium (loud rejection of legal C++; a contract that builds with the default backend fails
to build with `--compiler typescript`)**.

Repro: `corpus/solidity-port/triage/F201-alias-of-alias-base/` (`AliasBase.h`, `script.json`).

```
d=corpus/solidity-port/triage/F201-alias-of-alias-base
bun run scripts/solidity-port/triage.ts $d/AliasBase.h $d/script.json
# AliasBase: one-side-rejected
# TypeScript backend:
#   status rejected
#   ! unsupported member read [state.get(0).threeAliases.a]
#   ! unsupported assignment target [state.mut(0).threeAliases.a]
# clang backend:
#   status ok  digest e3a548973d5fe8cd…  stateSize 96
#   [ 1] function 1  out 2a00000000000000 2a00000000000000 2a00000000000000
exit 1
```

The declaration under test:

```cpp
namespace Port
{
struct Base { uint64 a; uint64 b; uint64 c; };
using BaseA = Base;
using BaseB = BaseA;
using BaseC = BaseB;
}

struct Direct       : public Port::Base  { uint64 d; };   // control — accepted
struct OneAlias     : public Port::BaseA { uint64 d; };   // control — accepted
struct ThreeAliases : public Port::BaseC { uint64 d; };   // rejected
```

Control: `Direct` and `OneAlias` are members of the **same** contract, written and read by the same
entries in the same build. The TypeScript backend accepts `state.get().direct.a` and
`state.get().oneAlias.a` and rejects only `state.get().threeAliases.a`, so the rejection is specific to
the alias depth and not to inheritance, to namespacing, or to the member name.

Oracle: clang compiles the contract and the run reads `42` back through all three bases
(`2a00000000000000` three times), with `stateSize 96` — three structs of four `uint64` each, which is
the correct layout for all three spellings. The chain is ordinary C++ typedef aliasing; nothing here is
outside the QPI subset.

The corpus sweep shows the same boundary independently, across the five `ns` spellings of the same
archetype:

```
match              namespaces/NsInheritedNamespacedTypedef__base   {}                        <- global
match              namespaces/NsInheritedNamespacedTypedef__64bf   {'ns': 'single'}          <- Port::Base
match              namespaces/NsInheritedNamespacedTypedef__7346   {'ns': 'alias'}           <- one alias
one-side-rejected  namespaces/NsInheritedNamespacedTypedef__7ee1   {'ns': 'aliasOfAlias'}    <- three aliases
match              namespaces/NsInheritedNamespacedTypedef__cb08   {'ns': 'collision'}       <- twin namespaces
```

This is the family the repo's own testing notes call out as having "produced nine silent bugs", and the
adjacent historical failure — a namespaced typedef whose `sizeof` came out 2 instead of 24 — is the
loud version of the same resolution path.

### F202 — harness defect, found and fixed during the campaign: the generator's nested-placement rewrite also rewrote the out-of-struct guard

Severity: **n/a (defect in this campaign's own generator, not in Qinit)**. Recorded because 13 contracts
reported `both-rejected` on the first sweep and the rule in `docs/testing-agent-prompt.md` — *"If a
probe fails, suspect the probe first"* — is what resolved it.

`scripts/solidity-port/emit.ts` implements the `placement=nested` axis by moving the archetype's members
into a nested `Inner` struct and textually rewriting `state.mut().X` to `state.mut().inner.X`. The
rewrite was unconditional, so it also rewrote `state.mut().placementGuard` — the guard member that
deliberately stays *outside* `Inner`, which is the entire point of it. Both backends correctly rejected
the result. Fixed with a negative lookahead; the 13 contracts now compile and match.

The episode is worth one line in this ledger for a second reason: it is the campaign's own evidence
that a `both-rejected` verdict is a probe smell, and that the two backends agreeing on a rejection tells
you nothing about whether the contract was meant to be rejected.

## Suite counts

Final sweep, `--tier full --workers 3` on 4 CPUs:

```
FAMILY                     match digest-mi step-mism trap-dive one-side- both-reje expect-vi harness-e
------------------------------------------------------------------------------------------------------
assets                        12         0         0         0         0         0         0         0
containers                    48         0         0         0         0         0         0         0
controlflow                   35         0         0         0         0         0         0         0
integers                     342         0         0         3         0         0         0         0
layout                        81         0         0         0         0         0         0         0
lifecycle                      5         0         0         0         0         0         0         0
logging                        6         0         0         0         0         0         0         0
namespaces                    59         0         0         0         1         0         0         0
vulnerabilities               13         0         0         0         0         0         0         0
------------------------------------------------------------------------------------------------------
605 contracts · 601 match · 4 not-match · 0 hang
```

The 4 non-matching rows are the two findings: three `sint32` variants of `DivQpi` (F200) and one
`aliasOfAlias` variant of `NsInheritedNamespacedTypedef` (F201).

Stimulus coverage, so the green rows are not vacuous: 580 of 605 contracts changed their state digest
mid-script, 5 emitted at least one log, 4 produced at least one trap, and 8 finished with an all-zero
state — all 8 the `loopShape=zero` variants of `LoopShapes`, where a zero-trip loop writing nothing is
the point of the row. Cold sweep: median 873 ms per contract (TypeScript ≈ 0.7 s, clang ≈ 1.5 s, run in
parallel), 3 min 49 s wall. Warm-cache re-run: median 81 ms, 2 min 06 s wall.

Harness controls (`bun test packages/compiler/tests/differential/solidity-port.test.ts`): 9 comparator
controls pass, each asserting the **exact** message for one class of difference — including
`reports a digest difference even when every step agrees`, which is the control that would fail if the
digest were computed and never compared. Corpus generation gate: 605 variants analyzed, 0 ERROR
diagnostics, 1 expected-reject confirmed. `bun run corpus:check`: clean. `bun run typecheck`: clean.

### Positive control — the sweep was made to fail on purpose

A suite that has never gone red is not evidence. One line was changed in the TypeScript backend,
`packages/compiler/src/shared/scalar-sizes.ts`, `uint16: 2` to `uint16: 4` — a plausible layout bug —
and the layout family was re-swept:

```
# with the mutant planted
81 contracts · 60 match · 21 step-mismatch
  step-mismatch layout/PackMixedWidths__base  step 0 (procedure 1): state digest differs
                                              ts c459febe8c896d3e… / clang 8c4372d2cb9aa5a9…
# after restoring the line
81 contracts · 81 match · 0 not-match
```

21 of 81 went red — every contract in the family carrying a `uint16` — each localised to the exact step.
This also exercises the compile cache's backend stamp: the cached artifacts are keyed on the TypeScript
backend's own source tree, so editing the compiler invalidated its half of the cache instead of
replaying the pre-mutation wasm and reporting a clean bill of health.

## Honest limitations

These belong with the numbers, not in a footnote.

1. **Both backends share a build gate and one `qpi.h`.** `buildContractWithClang` and the TypeScript
   path both call `analyzeContract` and `buildGateViolations` (`packages/build/src/compile/pipeline.ts`),
   deliberately, so they reject the same contracts. A bug in the gate is common-mode and **invisible**
   to this comparison.
2. **The simulator is a shared host.** Both artifacts run in the same `QubicSimulator`, so a host-side
   bug cancels out and reports `match`. **"601 matched" means "601 agreed with each other", not "601
   were right."** Neither finding here was confirmed against a live core node or against core-lite's
   WAMR gtest; both were derived from the wasm semantics and from clang being what core builds with.
   Confirming them on real core is the obvious next step and was not done.
3. **"Solidity" is provenance for the shape, not semantic equivalence.** `uint256` became `uint64`,
   `mapping` became a fixed-capacity `HashMap` that wraps when full, and `require` became a guard that
   does not roll back. A Solidity test whose whole point was atomicity or 256-bit wraparound is a
   *different* test after porting. `manifest.jsonl` marks each contract `faithful` or `shape-only`.
   Nothing here supports a claim that Qinit passes Solidity semantic tests.
4. **605 contracts are not 605 independent trials.** They are variants of 68 archetypes, so the
   effective sample size is far closer to 68. The variants earn their place as the *axis bisector* that
   made both findings precise — F200's `sint32`-only boundary and F201's alias-depth boundary each came
   from sibling variants differing in one axis — not as breadth.
5. **The corpus is 68 archetypes, not the few thousand contracts the campaign was scoped around.**
   The harness, the generator, the controls and the ledger are complete and the sweep is repeatable;
   what is short is archetype authoring, which is the one part that does not automate.
6. **Both findings are in the TypeScript backend, which may reflect where the corpus pointed.** The
   archetype families were chosen from this repo's own history of TypeScript-backend bugs, so the
   corpus is biased toward finding more of them.

## Reproducing

```sh
export QINIT_CORE=/path/to/core-lite
export WASM_CLANG=/path/to/wasi-sdk/bin/clang++ WASI_SYSROOT=/path/to/wasi-sdk/share/wasi-sysroot

bun run corpus:check                       # the committed corpus matches its generator
bun run corpus:analyze                     # every variant passes the shared build gate
bun run corpus:sweep -- --tier full --workers 3 --out work/results.jsonl
bun test packages/compiler/tests/differential/solidity-port.test.ts

# one contract, both backends, full per-step report
bun run scripts/solidity-port/triage.ts <contract.h> <script.json>
```

The sweep is resumable: results are appended as NDJSON and a re-run skips ids already present.
Compiled artifacts are cached under `work/cache`, keyed on the contract source, the qpi.h, the clang
toolchain **and the TypeScript backend's own source tree** — so editing the compiler under test
correctly invalidates its half of the cache rather than replaying yesterday's wasm.

---

# Round 2 — corpus expansion and cross-contract coverage

Same harness, same environment as above, plus `wasi-sdk-29` unchanged. Round 2 grew the corpus from 68
archetypes / 605 contracts to **118 archetypes / 1,204 contracts**, added the **cross-contract** family
that round 1 dropped entirely, and moved both backends onto the `@qinit/build` wrappers so a caller and
its callee are compiled through one options object.

## Round 2 summary

- **1 new confirmed defect** and **1 new documented divergence**, both from newly ported archetypes:
  - **F203** — `qpi.K12(<expression>)` hashes different bytes than `qpi.K12(<variable>)` holding the same
    value, under the TypeScript backend only. Convicted by a **third, independent oracle**, so this one
    does not rest on the two backends disagreeing.
  - **F204** — a shift by a count at or beyond the operand width diverges *only when the count is a
    compile-time constant*. This is undefined behaviour in C++, so neither backend is wrong; what is
    reportable is that clang's own folded and runtime spellings disagree with each other, and that
    testing under `--compiler typescript` therefore cannot predict the on-chain answer.
- **F202 (harness)** is closed: the generator defect round 1 recorded is fixed and its 13 contracts pass.
- **F200 and F201 still reproduce**, unchanged, on the same variants.
- The backend switch was verified to change nothing: re-running round 1's 605 contracts through the new
  wrappers gave the identical 601 match / 4 non-match, same four rows.

### F203 — `qpi.K12` of a computed expression hashes different bytes than `qpi.K12` of a variable holding that value

Severity: **high (silent wrong hash: a commitment or Merkle root computed inline differs from what the
chain would produce, with no diagnostic on either side)**.

Repro: `corpus/solidity-port/triage/F203-k12-expression/` (`K12Struct.h`, `script.json`).

```
d=corpus/solidity-port/triage/F203-k12-expression
bun run scripts/solidity-port/triage.ts $d/K12Struct.h $d/script.json
# K12Struct: step-mismatch — step 0 (procedure 1): state digest differs
#
# with a = 1, b = 1, the Read function returns
#   ofMember  ofLocal  ofSumExpression  ofProductExpression  witness
#
# TypeScript backend:
#   61d86f04…  4e34329a…  dc545078…  11e55263…  2
# clang backend:
#   61d86f04…  4e34329a…  4e34329a…  61d86f04…  2
exit 1
```

The contract's four rows are one value hashed four ways:

```cpp
state.mut().ofMember           = qpi.K12(input.a);          // control: a plain member
locals.sum                     = input.a + input.b;
state.mut().ofLocal            = qpi.K12(locals.sum);       // control: a named local
state.mut().ofSumExpression    = qpi.K12(input.a + input.b);   // the finding
state.mut().ofProductExpression = qpi.K12(input.a * 1);        // the finding
```

Oracle — and this is the part that assigns blame without appealing to either backend. core's K12 is one
line, `src/qpi/impl/qpi_trivial_impl.h:111`:

```cpp
template <typename T>
m256i QPI::QpiContextFunctionCall::K12(const T& data) const
{
    m256i digest;
    KangarooTwelve(&data, sizeof(data), &digest, sizeof(digest));
    return digest;
}
```

`T` is `uint64` in every one of the four rows, so all four must hash exactly the eight little-endian
bytes of their value. Computing that directly with the engine's own KangarooTwelve:

```
K12(uint64 1) = 61d86f0409ed80b1ad74e4ac47c4ce53cd7bf5267e1435b779af4ed907179d98
K12(uint64 2) = 4e34329a1bac6e80862edb5e727be3dcc7d1169670a179622a21be84ff826f6e
```

clang produces exactly those for all four rows. The TypeScript backend produces them for the two rows
whose argument is a plain variable and something else — `dc545078…`, `11e55263…` — for the two whose
argument is an expression. **clang is right; the TypeScript backend is wrong.**

Controls, all inside the same contract and the same build: `qpi.K12(input.a)` and `qpi.K12(locals.sum)`
agree with clang and with the external oracle, so neither `qpi.K12` in general nor this contract's layout
is implicated — only the temporary. Two further probes rule out the neighbouring suspects: `qpi.K12` over
a 16-byte struct, over an `Array<uint64,4>` and over a struct of two `id`s all agree across backends, and
so does `operator<` on `id`. The defect is specifically an argument that is a computed temporary.

How it was found is worth recording: no probe was written for it. It fell out of
`MerkleProofIterativeVerify`, a port of OpenZeppelin's `processProof`, whose fold hashes `seed + i`. That
is exactly the case for a corpus of shapes nobody here designed — the archetype was written to test
Merkle index arithmetic and caught a hashing bug instead. The archetype now hashes through a named local
so it tests what it was written for, and `K12OfComputedExpression` carries the finding as a standing row.

### F204 — a shift by an out-of-range count diverges only when the count is a compile-time constant, and clang's own two spellings disagree

Severity: **low–medium (undefined behaviour, so neither backend is wrong; but a contract that shifts by
an out-of-range constant gets a different result under `--compiler typescript` than on chain, and clang
answers the same expression two different ways depending on whether it folds)**.

Repro: `corpus/solidity-port/triage/F204-constant-shift-count/` (`ConstShift.h`, `script.json`).

```
d=corpus/solidity-port/triage/F204-constant-shift-count
bun run scripts/solidity-port/triage.ts $d/ConstShift.h $d/script.json
# ConstShift: step-mismatch — step 0 (procedure 1): state digest differs
#
# with value = 1 and a runtime count of 254, the Read function returns
# ts:    foldedOutOfRange=4611686018427387904  runtimeOutOfRange=4611686018427387904  agreeOutOfRange=1
# clang: foldedOutOfRange=0                    runtimeOutOfRange=4611686018427387904  agreeOutOfRange=0
#        foldedInRange=8  runtimeInRange=8  agreeInRange=1        (on both backends)
exit 1
```

The four rows are one shift written two ways, twice:

```cpp
static constexpr uint8 FOLDED_COUNT = 254;      // >= the operand width
static constexpr uint8 FOLDED_IN_RANGE = 3;     // control

locals.scratch = input.value << FOLDED_COUNT;   // the finding: foldable, out of range
locals.scratch = input.value << input.count;    // control: same count, arrives at runtime
locals.scratch = input.value << FOLDED_IN_RANGE;   // control: foldable, in range
locals.scratch = input.value << (uint8)3;          // control: runtime, in range
```

What each backend does with `1 << 254` on a `uint64`:

| | folded count | runtime count | self-consistent |
| --- | --- | --- | --- |
| TypeScript | 2^62 = 4611686018427387904 | 2^62 | **yes** |
| clang | 0 | 2^62 | **no** |

2^62 is `1 << (254 mod 64)`, which is what wasm's `i64.shl` does — it masks the count to six bits. So the
runtime answer is 2^62 on both, as the instruction requires. The difference is the *folded* path: clang's
constant folder resolves the undefined shift to 0, while the TypeScript backend folds it the same way its
runtime code evaluates it.

Oracle, and the reason this is filed as a divergence rather than a defect: `x << n` with `n >= width` is
**undefined behaviour in C++** ([expr.shift]), so both answers are permitted and neither backend can be
called wrong. Solidity, which is where the archetype came from, *does* define it — `shift_left_larger_type.sol`
expects 0 — which is why the port carries the caveat that a disagreement here is expected signal.

Controls: both in-range rows agree on both backends and between the folded and runtime spellings
(`foldedInRange = runtimeInRange = 8`), so neither shift codegen nor constant folding in general is
implicated. And the width sweep bounds it precisely — of 16 `ShiftRhsWiderThanLhs` variants, the four
that diverge are exactly the 32- and 64-bit widths with `constSource=constexpr`:

```
match          integers/ShiftRhsWiderThanLhs__eb8b   {'width': 'uint8',  'constSource': 'input'}
match          integers/ShiftRhsWiderThanLhs__65a3   {'width': 'uint8',  'constSource': 'constexpr'}
match          integers/ShiftRhsWiderThanLhs__5a7d   {'width': 'uint32', 'constSource': 'input'}
step-mismatch  integers/ShiftRhsWiderThanLhs__3d86   {'width': 'uint32', 'constSource': 'constexpr'}
step-mismatch  integers/ShiftRhsWiderThanLhs__5bf5   {'width': 'uint64', 'constSource': 'constexpr'}
step-mismatch  integers/ShiftRhsWiderThanLhs__9103   {'width': 'sint32', 'constSource': 'constexpr'}
step-mismatch  integers/ShiftRhsWiderThanLhs__0599   {'width': 'sint64', 'constSource': 'constexpr'}
```

`uint8`/`uint16`/`sint8`/`sint16` agree because integer promotion widens them to `int` before the shift,
and both backends then treat the promoted operand the same way. The `constSource` axis is what separated
the two spellings; without it this would have looked like an ordinary width-dependent shift difference.

## Round 2 suite counts

Full sweep, `--tier full --workers 3` on 4 CPUs, 3 min 02 s wall:

```
FAMILY                     match digest-mi step-mism trap-dive one-side- both-reje expect-vi harness-e
------------------------------------------------------------------------------------------------------
assets                        12         0         0         0         0         0         0         0
containers                   151         0         0         0         0         0         0         0
controlflow                   35         0         0         0         0         0         0         0
integers                     618         0         7         3         0         0         0         0
intercontract                 18         0         0         0         0         0         0         0
layout                       219         0         0         0         0         0         0         0
lifecycle                      5         0         0         0         0         0         0         0
logging                        6         0         0         0         0         0         0         0
namespaces                   116         0         0         0         1         0         0         0
vulnerabilities               13         0         0         0         0         0         0         0
------------------------------------------------------------------------------------------------------
1204 contracts · 1193 match · 11 not-match · 0 hang
```

The 11 non-matching rows are four findings and nothing else: 3 `DivQpi` sint32 variants (F200),
1 `NsInheritedNamespacedTypedef` aliasOfAlias variant (F201), 3 `K12OfComputedExpression` variants
(F203) and 4 `ShiftRhsWiderThanLhs` constexpr variants (F204).

Stimulus coverage: 1,160 of 1,204 contracts moved their state digest mid-script, 5 emitted at least one
log, 4 produced at least one trap, **18 made a cross-contract call**, and 44 finished with an all-zero
state — the `loopShape=zero` and `initStyle=absent` variants, where writing nothing is the row's point.

Positive control, re-run at the new size: planting `uint16: 2 → 4` in
`packages/compiler/src/shared/scalar-sizes.ts` turned **37 of the 219 layout contracts red** (round 1:
21 of 81), and restoring the line returned all 219 to green. `bun run corpus:check`: 1,216 files, 1,204
contracts, clean. `bun run corpus:analyze`: 1,204 variants, 0 ERROR diagnostics, 1 expected-reject.
`bun run typecheck`: clean. Harness controls: 16 pass, 0 fail — 12 comparator controls including three
new pair controls, plus corpus-integrity checks that every callee sits at a strictly lower slot than its
caller.

## What round 2 changed in the harness

- **Both backends now go through the `@qinit/build` wrappers** (`buildContractWithTypeScript` /
  `buildContractWithClang`), which take a field-identical options object. That is what makes
  `dynCallees` mean the same thing to both and gives cross-contract support without new plumbing.
  Verified not to move anything: re-running round 1's 605 contracts through the wrappers reproduced the
  identical 601 match / 4 non-match, same four rows.
- **Pairs are compiled, deployed and compared as pairs.** The callee is built standalone, the caller with
  `dynCallees`; they deploy ascending by slot (callee at 28, caller at 29) because the registry runs
  `INITIALIZE` on first deploy; and **both slots' digests are compared**, since cross-contract writes land
  in the callee and comparing only the caller would report a false match.
- **The compile cache now covers the callee's source and slot.** Without that a caller cached under the
  old key would survive a callee edit and replay stale wasm.
- **Four axes that were declared but not applied are now real**: `temporaries` (locals arena vs a scratch
  sub-struct of state), `initStyle` (INITIALIZE full / empty / omitted), `entryShape` (body inline vs
  reached through a `PRIVATE_*` entry and `CALL`), `constSource` (operand from input vs a `constexpr`).
  `constSource` is what produced F204.
- **The variant cap changed** from "exhaustive up to 400" to "exhaustive when the cross product is ≤ 32,
  otherwise a pairwise cover capped at 32", because six axes make a full cross product explode.

## Round 2 limitations

Everything in round 1's limitations still holds unchanged — the shared build gate, the shared `qpi.h`,
and above all the shared `QubicSimulator`: **"1,193 matched" still means they agreed with each other**,
not that they were right. Cross-contract adds a shared host path (`liteCallFunction`) with exactly the
same property. No finding in this ledger has been confirmed against real core or WAMR; that remains the
obvious next step and remains undone.

Two things are specific to round 2:

- **1,204 contracts came from 118 archetypes**, so the effective sample is nearer 118 than 1,204. The
  corpus is short of the ~250 archetypes the round was scoped around; what was delivered is the harness
  work, the cross-contract family, the four new axes, and roughly 50 new archetypes. The remaining
  archetype ideas are catalogued and the generator takes them without further plumbing.
- **F204 is not a defect and should not be read as one.** Shifting past the operand width is undefined in
  C++; the finding is the *inconsistency*, not a wrong answer, and the TypeScript backend is arguably the
  better-behaved of the two there.
