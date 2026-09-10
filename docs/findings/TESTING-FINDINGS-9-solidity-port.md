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

> This section is round 1. The campaign has since run four more times, at the bottom of this file.
> Current state after **round 5**: 411 archetypes / 6,091 contracts, 6,009 matching, **twelve findings**
> — F200, F201, F203, F204, F205, F209, F210, F211, F212, F213, F214, F215 — plus five harness/engine
> defects (F202, F206, F207, F208, F216), each recorded where it was found and each fixed. F200 is
> confirmed against a third oracle (core's own headers compiled natively by g++); the rest still rest on
> the two backends disagreeing, and nothing here has been run against real core or WAMR.

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

# Round 3 — three times the corpus, and six axes every archetype gets for free

Same harness, same environment as rounds 1 and 2 (`core-lite`, `wasi-sdk-29`, one `QubicSimulator` per
cell, clang from `wasi-sdk-29`). Round 3 grew the corpus from **118 archetypes / 1,204 contracts** to
**171 archetypes / 3,647 contracts** — the 3× the round was asked for — and got there from two
directions at once: **53 new archetypes** in the families round 2 left thinnest, and **six axes that now
apply to every archetype without it opting in**.

## Round 3 summary

- **1 new divergence, F205** — an unqualified name that is both a file-scope enum constant and a member
  of the contract. C++ looks up names inside a member function in class scope first, so clang takes the
  member and refuses the assignment; the TypeScript backend takes the enum constant and compiles. Same
  direction as F201: the TypeScript backend accepts a program clang refuses, so a contract can pass
  local testing and then fail the build that produces the on-chain artifact.
- **2 new harness defects, F206 and F207**, both found and fixed inside the round, both surfaced only
  because the axes became universal. Recorded here for the same reason F202 was: a generator defect that
  goes unrecorded looks like a compiler finding the next time someone reads the scoreboard.
- **F200, F201, F203 and F204 all still reproduce**, on the same archetypes, unchanged — now across 38
  rows instead of 11, because the new axes multiply each finding's variants.
- **No other divergence anywhere in 3,647 contracts.** 3,609 matched; the 38 that did not are those four
  findings and nothing else.

### F205 — a file-scope enum constant hidden by a contract member: clang rejects, the TypeScript backend accepts

Severity: **medium (a contract that compiles under `--compiler typescript` and fails the clang build; no
silent wrong answer, because the divergence is a compile error on one side)**.

Repro: `corpus/solidity-port/triage/F205-enum-hidden-by-member/` (`EnumHidden.h`, `script.json`).
Corpus rows: `namespaces/NsEnumConstantHiddenByMember__*`, which pin the divergence deliberately.

```
d=corpus/solidity-port/triage/F205-enum-hidden-by-member
bun run scripts/solidity-port/triage.ts $d/EnumHidden.h $d/script.json

# EnumHidden: one-side-rejected
# TypeScript backend:
#   status ok  digest 1d91cfaafe467e98…  stateSize 24
#   [ 1] function 1  out 0300000000000000 0400000000000000 0a00000000000000
#                        ^ hidden = 3       ^ control = 4     ^ helperCalls
# clang backend:
#   status rejected
#   ! error: assigning to 'uint64' from incompatible type
#     'void (const QPI::QpiContextFunctionCall &, …, Helper_input &, Helper_output &, Helper_locals &)'
```

The contract declares `enum Kind { Helper = 3, Solo = 4 };` at file scope and a `PRIVATE_FUNCTION(Helper)`
inside the contract, then writes `state.mut().hidden = Helper;` from a procedure. C++ name lookup inside
a member function searches class scope before the enclosing namespace, so `Helper` is the member function
and the assignment is ill-formed — which is exactly what clang says. The TypeScript backend resolves the
same spelling to the enum constant and stores 3.

`Solo` is the control: the same assignment through an enum constant that no member hides, which both
backends accept and both store as 4. So the disagreement is specifically about the hiding rule and not
about enum constants, and the whole thing is decided by one build of one contract.

This is the third finding in the same family as F201 and the round-1 namespace bugs: the TypeScript
backend's name resolution is more permissive than C++'s, and where it is more permissive it silently
picks a different entity rather than reporting an ambiguity.

### F206 — harness defect, found and fixed during the round: the `temporaries` axis hoisted a function's locals into state

The `temporaries=stateScratch` axis moves an entry's `_locals` members into a scratch sub-struct of
`StateData` and rewrites `locals.x` to `state.mut().scratch.x`. Applied to a **function**, that makes a
read-only entry write through `state.mut()`, which both build gates refuse — so eleven contracts came
back `both-rejected`, testing nothing. The axis now rewrites procedures only; a function keeps its
locals, and the variant renders identically to the `locals` spelling and is dropped by the dedup.

### F207 — harness defect, same shape: `entryOrder` reordered entries whose types depend on each other

`entryOrder=reversed` declares the contract's entries back to front. Where one entry's `_locals` names
another entry's `_input` — a private helper reached by `CALL`, or a public entry that shares a guard —
reversing them emits the member before its type exists, and clang rejects with `unknown type name`
(three `ModifierAsPrivateFunction` variants did exactly this). The axis now stands down for any contract
with such a dependency. The invariant is pinned by a corpus-wide control that walks every emitted
contract and asserts that an entry naming another entry's I/O struct is always declared after it, so the
next axis that reorders declarations cannot reintroduce this quietly.

## Round 3 suite counts

```
bun run corpus:check      3659 files, 3647 contracts, clean
bun run corpus:analyze    3647 variants, 0 ERROR diagnostics, 16 expected-reject
bun run corpus:sweep -- --tier full --workers 4
                          3647 contracts · 3609 match · 38 not-match · 0 hang
                          median 842ms · wall 738s
```

The 38 non-matching rows are the four known findings and nothing else: 19 `K12OfComputedExpression`
(F203), 10 `ShiftRhsWiderThanLhs` constexpr variants (F204), 5 `NsInheritedNamespacedTypedef`
aliasOfAlias variants (F201) and 4 `DivQpi` sint32 variants (F200). F205's own rows are scored as
matches because the archetype documents the divergence through `expectedVerdict`: it passes by diverging
exactly as described and fails the moment it stops.

Stimulus coverage: 3,462 of 3,647 contracts moved their state digest mid-script, 144 emitted at least one
log, 21 produced at least one trap, **143 made a cross-contract call**, and 110 finished with an all-zero
state — the `loopShape=zero` and `initStyle=absent` variants, where writing nothing is the row's point.

Positive control, re-run at the new size: planting `uint16: 2 → 4` in
`packages/compiler/src/shared/scalar-sizes.ts` turned **89 of the 484 layout contracts red** (round 2: 37
of 219; round 1: 21 of 81), and restoring the line returned all 484 to green in the same command. So the
sweep still fails when the compiler under test is wrong, at three times the size, and the compile cache
still keys on the backend's own source.

`bun run typecheck` (root project, which covers `scripts/`): clean.

## What round 3 changed in the harness

- **Six axes are now universal.** `emitContract` takes the variant's whole axis assignment and applies
  `placement`, `temporaries`, `initStyle`, `entryShape`, `stateOrder` and `entryOrder` from it, and the
  generator adds those six to every archetype's declared axes. Before this, 15 archetypes opted into no
  axis at all and 16 into `placement` alone, so most of round 2's contract count came from a handful of
  integer and layout archetypes. This is the change that made 3× reachable without inventing 350 more
  archetypes: an archetype now varies along every axis it can support, and one it cannot support renders
  identically under both values and is dropped by the source-fingerprint dedup — so the count cannot be
  inflated by an axis nobody applies.
- **Two new axes**, both real declaration differences rather than new stimulus: `stateOrder` declares
  `StateData`'s members back to front, which moves every offset after the first member; `entryOrder`
  declares the entries back to front, which changes nothing about the IDL or the registration numbers and
  therefore isolates declaration order on its own.
- **53 new archetypes**, weighted to the families round 2 left thinnest — lifecycle 3 → 11, logging
  4 → 10, vulnerabilities 5 → 13, assets 4 → 11, controlflow 6 → 14, containers 13 → 19, intercontract
  6 → 10, layout 17 → 22. New ground they cover: `HashMap::removeByKey` markers and `cleanup()`
  compaction (no Solidity analogue at all — a mapping never compacts), `HashSet` churn, `Array::setRange`
  and `rangeEquals` at inverted and out-of-range bounds, epoch settlement inside `END_EPOCH`, hook
  ordering, OpenZeppelin's `PullPayment` / `AccessControl` / `Nonces` / `VestingWallet` and the
  MasterChef reward-per-share accumulator, tx.origin-versus-msg.sender authorisation (which ports
  faithfully, since QPI exposes both), a cross-contract call made from inside a loop and from inside a
  private procedure, and three-deep nested arrays.
- **A `--only <pattern>` flag on `generate.ts --analyze-only`**, which is what made authoring a batch of
  archetypes a seconds-long loop instead of a full-corpus one.

## Round 3 limitations

Everything in rounds 1 and 2 still holds, unchanged and still the most important thing on this page: both
backends share one build gate, one `qpi.h` and the same `QubicSimulator`, so **"3,609 matched" means they
agreed with each other**, not that either was right. No finding in this ledger has been confirmed against
real core or WAMR. That is still the obvious next step and it is still undone.

Three things are specific to round 3:

- **3,647 contracts came from 171 archetypes**, so the effective sample is nearer 171 than 3,647 — and
  the ratio is worse than round 2's, not better: 21 variants per archetype against 10. The axes earn
  their place as the bisector that made F200, F201 and F204 precise, and F205 was found by a *new
  archetype*, not by a new axis. Read the contract count as breadth of spellings, not as independent
  trials.
- **`stateOrder` and `entryOrder` are permutations, not new semantics.** They re-spell a contract the
  archetype already wrote. That is genuinely worth testing — struct offsets and declaration order are
  where this compiler has broken before — but a reader should not take "3,647 contracts" as 3,647
  distinct behaviours under test.
- **The two harness defects above were found by the sweep going red, not by review.** Both had the same
  signature: an axis applied where the archetype could not support it, producing a rejection that says
  nothing about either compiler. The corpus-wide invariant test added for F207 covers the declaration
  ordering; there is no such guard for a *semantic* axis misapplication, and the honest position is that
  the next one would again show up as an unexplained `both-rejected` cluster.

# Round 4 — the same 3,000 contracts, from 50% more archetypes

Round 3 ended with an admission: 3,647 contracts came from 171 archetypes, and the variants-per-archetype
ratio had got *worse*, not better. Round 4 spends the same contract budget the other way. The committed
tier's variant cap drops from 32 to 12 and **84 new archetypes** are authored, so the corpus is
**255 archetypes / 3,017 contracts** — the same order of size as round 3, from half again as many
distinct shapes. It also adds the campaign's first oracle that is not one of the two backends.

## Round 4 summary

- **Five new findings**, four of them in the same place: how the TypeScript front end resolves names.
  - **F213** — a qualified enum constant resolves to the **last-declared constant of that name**,
    anywhere in the file. `Alpha::Low` returns `Beta::Low`'s value. Silent, arithmetic, no diagnostic.
    This is the worst thing this campaign has found.
  - **F212** — a `PUBLIC_FUNCTION` may `CALL` a `PRIVATE_PROCEDURE` under the TypeScript backend and
    **write contract state from a read-only entry**. clang refuses the same contract outright.
  - **F211** — a nested struct whose name matches a file-scope struct sends the analyzer into unbounded
    recursion: `Maximum call stack size exceeded`. clang compiles it.
  - **F210** — `namespace M { using T = N::T; }` (an alias whose name equals its target's) **hangs** the
    front end outright. Because the clang pipeline runs the same build gate, it takes both backends down.
  - **F209** — the global-scope qualifier `::name` is a parse error for the TypeScript backend and
    ordinary C++ for clang.
- **One engine/harness defect, F208**: `qpi.computor(i)` answers differently in every simulator
  instance, so any contract reading it is non-reproducible — including between two runs of the *same*
  backend. Pinned in the harness for the indices the simulator lets us pin.
- **F200 is now confirmed by a third oracle.** `scripts/solidity-port/native-oracle/` compiles core's own
  `div`/`mod` definitions natively with g++ for x86-64: `div<sint32>(INT32_MIN, -1)` faults there too, so
  clang's trap is the correct behaviour and the TypeScript backend's `INT32_MIN` is the outlier. This is
  the first result in this ledger that does not rest on the two backends disagreeing.
- **F203, F204, F200 and F201 all still reproduce**, unchanged.

### F213 — a qualified enum constant resolves to the last-declared constant of that name

Severity: **critical (silent wrong value, no diagnostic, ordinary code triggers it)**.

Repro: `corpus/solidity-port/triage/F213-twin-enum-resolution/` (`TwinEnum.h`, `script.json`, `NOTES.md`).
Corpus rows: `namespaces/NsTwinEnumSameConstantNames__*`, all 12 red.

```
d=corpus/solidity-port/triage/F213-twin-enum-resolution
bun run scripts/solidity-port/triage.ts $d/TwinEnum.h $d/script.json

# namespace Alpha     { enum Level      { Low = 1,   High = 2   }; }
# namespace Beta      { enum Level      { Low = 100, High = 200 }; }
# namespace TwinName  { enum FirstKind  { Only = 7 }; }
# namespace OtherName { enum SecondKind { Only = 9 }; }
#
#   read                      clang   TypeScript backend
#   Alpha::Low                    1                  100
#   Alpha::High                   2                  200
#   Beta::Low                   100                  100
#   Beta::High                  200                  200
#   Alpha::High * Beta::Low     200                20000
#   TwinName::Only                7                    9
#   OtherName::Only               9                    9
```

Every read is fully qualified, so C++ has nothing to disambiguate and clang's column is simply correct.
The TypeScript backend returns the value of the last constant declared under that name — and the last
two rows show the collision is on the **constant identifier alone**: `FirstKind` and `SecondKind` are
different enum types in different namespaces, and `TwinName::Only` still comes back as 9.

Qualification is the fix a developer reaches for when two declarations collide. Here it is accepted and
ignored, which is what makes this worse than F201, F205, F209 and F211: those refuse to compile, so the
developer finds out. This one compiles, runs, and writes the wrong number into contract state.

### F212 — a read-only entry can call a procedure and mutate state

Severity: **high (the read-only guarantee for functions does not hold in one backend)**.

Repro: `corpus/solidity-port/triage/F212-function-calls-procedure/`. Corpus rows:
`controlflow/ReadOnlyFunctionCallsPrivateProcedure__*`, pinned through `expectedVerdict`.

clang refuses the contract, because the `CALL` macro hands the caller's context straight through:

```
error: no viable conversion from 'const QPI::QpiContextFunctionCall'
                              to 'const QPI::QpiContextProcedureCall'
    CALL(Bump, locals.request, locals.reply);
```

The TypeScript backend compiles it and runs it: the function returns 1, meaning
`state.mut().counter += 1` executed inside an entry that is supposed to be a query, and the contract's
state digest moves across a *function* call. `lifecycle/FunctionMustNotMutate` exists in this corpus
precisely to assert that never happens.

### F211 — a nested struct name colliding with a file-scope struct overflows the analyzer's stack

Severity: **medium (crash instead of a diagnostic; clang compiles the same file)**.

Repro and full explanation: `corpus/solidity-port/triage/F211-nested-struct-name-collision/NOTES.md`.
Corpus rows: `layout/LayoutNestedStructNameCollision__*`, pinned. Found by accident — the generator's
`placement=nested` axis wraps state members in a struct it calls `Inner`, and an archetype that happened
to declare a file-scope `Inner` collided with it, so 4 of that archetype's 12 variants failed.

### F210 — the front end does not terminate on an alias whose name equals its target's

Severity: **high (a contract source can hang the toolchain indefinitely, and it hangs the clang path too)**.

Repro and controls: `corpus/solidity-port/triage/F210-same-name-alias-hang/NOTES.md`.

```
namespace Inner  { struct Payload { uint64 a; }; }
namespace Middle { using Payload = Inner::Payload; }   // alias name == target name
```

Both `g++` and the wasi-sdk `clang++` compile that declaration pair without complaint. The qinit
analyzer never returns. This one is deliberately **not** in the generated corpus: a hang would burn a
shard deadline on every sweep, and the archetype that produced it was removed for that reason.

### F209 — the global-scope qualifier `::name` is refused

Severity: **low (loud rejection of legal C++; the workaround is to rename)**.

Repro: `corpus/solidity-port/triage/F209-global-scope-qualifier/`. Corpus rows:
`namespaces/NsGlobalScopeQualifier__*`, pinned. `Port::threshold` parses in the same file, so the refusal
is specific to the leading `::`.

### F208 — engine defect: `qpi.computor(i)` is not reproducible between runs

Severity: **medium (any test that reads the committee is non-deterministic, in both backends)**.

The simulator generates a committee per instance, so a contract that stores `qpi.computor(0)` produces a
different digest on every run — including two runs of the same backend, which is how it was caught: the
first hostcalls sweep reported a digest divergence that survived neither a re-run nor a backend swap.

`QubicSimulator.setComputorKey(index, key)` pins one index, and the harness now pins 0..675 before every
run (`scripts/solidity-port/execute.ts`). It cannot pin more than that: the override is keyed by the raw
index while the fallback wraps modulo the committee size, so `computor(65535)` still lands on an
unpinned entry. The corpus archetype therefore drives only the in-range indices, and says so in its
caveat. Fixing this properly belongs in the engine, not the harness.

## Round 4 suite counts

```
bun run corpus:check      3030 files, 3017 contracts, clean
bun run corpus:analyze    3017 variants, 0 ERROR diagnostics,
                          57 expected-reject or documented-divergence
bun run corpus:sweep -- --tier full --workers 4
                          3017 contracts · 2986 match · 31 not-match · 0 hang
                          median 61ms · wall 384s
```

The 31 non-matching rows are six findings and nothing else: 12 `NsTwinEnumSameConstantNames` (F213),
12 `K12OfComputedExpression` (F203), 3 `ShiftRhsWiderThanLhs` (F204), 2 `DivQpi` (F200) and
2 `NsInheritedNamespacedTypedef` (F201). F205, F209, F211 and F212 are scored as matches through
`expectedVerdict`: they pass by diverging exactly as documented and fail the moment they stop.

Stimulus coverage: 2,863 of 3,017 contracts moved their state digest mid-script, 142 emitted at least one
log, 13 produced at least one trap, **161 made a cross-contract call**, and 80 finished all-zero.

Positive control: planting `uint16: 2 → 4` in `packages/compiler/src/shared/scalar-sizes.ts` turned
**57 of the 369 layout contracts red**, and restoring it returned all 369 to green. Harness controls:
18 pass. `bun run typecheck` (root project): clean.

## What round 4 changed

- **The tier cap is 12, not 32.** With six universal axes the cross product never fits under any cap, so
  a bigger number buys more spellings of the same archetype rather than more shapes. 255 × 12 is a
  better corpus than 171 × 32 at the same size, and the ratio finally moved the right way.
- **84 new archetypes**, including a new family. `hostcalls` (18 archetypes) covers the QPI host
  interface that three rounds never touched: `nextId`/`prevId`, `isContractId`, `computor`, `getEntity`,
  `transfer`, `burn`, `signatureValidity`, `distributeDividends`, the seven calendar fields, `dayOfWeek`,
  and the tick/epoch counters. `assets` gained five archetypes that use the **real share API** —
  `issueAsset`, `transferShareOwnershipAndPossession`, `numberOfPossessedShares`, `isAssetIssued` — where
  the state under test is partly in the host's asset universe rather than in the contract. The rest went
  to wide arithmetic (mulDiv through lanes, gcd, rotate, clz, popcount, isqrt, carry chains), advanced
  containers (`Collection`'s priority queue, engineered key collisions, an `Array` of `HashMap`s, a
  struct holding two containers, `BitArray<2048>`), DeFi failure modes (constant-product invariant,
  precision-loss reward split, commit-reveal, replay without a nonce), and dispatch shapes (sparse entry
  numbers, twelve registered entries, a helper shared by a function and a procedure).
- **A third oracle exists.** `scripts/solidity-port/native-oracle/` — see its README. Small, but it is
  the first thing in this campaign that can say *which* backend is right rather than only that they
  differ.
- **Hand-derived `expect` rows.** `WidePopcountTwoWays` and `WideCountLeadingZeros` carry per-step
  expected outputs computed from the operand rather than from either compiler, so those rows can catch
  the two backends agreeing on a wrong answer. Twelve rows so far; the machinery has been there since
  round 1 and was barely used.
- **`emitContract` supports hook locals** (`END_TICK_WITH_LOCALS` and friends), which is what a
  cross-contract call from a tick hook needs — the request and reply buffers have nowhere else to live.

## Round 4 limitations

- **The shared-component caveat still stands for nine of the ten findings.** Both backends share one
  build gate, one `qpi.h` and one `QubicSimulator`; only F200 has been checked against anything else. A
  bug in the shared parts is still invisible to this method, and the twelve `expect` rows are the only
  place in 3,017 contracts where an answer is asserted rather than compared.
- **The native oracle does not run contracts.** It evaluates arithmetic from core's headers. Confirming
  a *state digest* against real core needs `contract_testing.h`, gtest, and a registered contract index;
  that is still the obvious next step and still undone.
- **F213 was found by one archetype.** Twelve red rows all come from one shape, and three earlier rounds
  of namespace archetypes did not produce it — the earlier twins compared *layouts*, not *values*. That
  is a reminder that the corpus finds what its archetypes look at, and 3,017 contracts is not a claim
  about the ones nobody wrote.
- **F208 is fixed only for the range the simulator lets us pin.** An archetype that reads
  `computor(676)` would still be non-reproducible, and nothing in the harness prevents someone writing
  one; the guard is a comment in the archetype's caveat, not a check.

# Round 5 — 6,000 contracts from 411 archetypes, and two more parser refusals

Round 4 argued that the archetype count is the sample size and spent its budget accordingly. Round 5
doubles the corpus while keeping that ratio: **411 archetypes / 6,091 contracts** (round 4: 255 / 3,017),
from **156 new archetypes** and a variant cap lifted only from 12 to 17. The average is 14.8 variants per
archetype against round 4's 11.8, so the corpus grew mostly by growing the number of distinct shapes.

## Round 5 summary

- **Two new findings, both refusals of legal C++**, and both found while writing archetypes rather than
  by the sweep:
  - **F214** — `sizeof` of a template with more than one argument (`sizeof(Array<uint64, 8>)`) is a parse
    error in the TypeScript backend. Every QPI container takes at least two template arguments, so this
    is how a contract asks how big its own state is.
  - **F215** — a member read on the `SELF` constant (`SELF.u64._0`) is refused; the identical read
    through a local `id` copy compiles, and clang accepts both.
- **F213 got much worse on inspection.** Round 4 recorded it as "a qualified enum constant resolves to
  the last-declared constant of that name". Round 5's value probes show the rule is broader: **a constant
  identifier is effectively global**, and the last declaration of that name wins regardless of namespace,
  enum type, or even *kind* of declaration — an enum constant overwrites a file-scope `constexpr` of the
  same name. A four-namespace ladder returns the fourth namespace's value for all four reads.
- **One harness defect, F216**: an archetype whose script advanced 3,600 ticks cost about forty seconds
  of simulator time per backend and blew a shard deadline, which the sweep reported as a hang. The script
  now advances 240 ticks and exercises the same boundaries.
- **The secondary oracle is no longer a token gesture.** Round 4 had twelve hand-derived `expect` rows;
  round 5 has **over a hundred**, spread across the arithmetic, cast, control-flow, layout and DeFi-math
  archetypes. They caught **eleven of my own derivation errors** during authoring — every one a case
  where I predicted the wrong number and both backends agreed on the right one.

### F213, restated — a constant name is global and the last declaration wins

Severity: **critical (silent wrong value, no diagnostic, ordinary code triggers it)**.

Repro: `corpus/solidity-port/triage/F213-twin-enum-resolution/` — extended this round with a file-scope
constant colliding with an enum constant.

```
namespace Alpha     { enum Level      { Low = 1,   High = 2   }; }
namespace Beta      { enum Level      { Low = 100, High = 200 }; }
namespace TwinName  { enum FirstKind  { Only = 7 }; }
namespace OtherName { enum SecondKind { Only = 9 }; }
static constexpr uint64 Shared = 5;
namespace WithEnum  { enum Kinds      { Shared = 55 }; }

  read                                   clang   TypeScript backend
  Alpha::Low                                 1                  100
  Alpha::High                                2                  200
  TwinName::Only                             7                    9
  Shared          (file-scope constexpr)     5                   55
  WithEnum::Shared                          55                   55
```

The corpus now carries three archetypes on this: the original twin pair, a four-namespace ladder
(`K1::Tag = 1` through `K4::Tag = 8`, where clang ORs them to 15 and the TypeScript backend to 8), and
an enum-versus-file-constant pair. Thirty-nine rows, all red, none pinned — they should go green when it
is fixed.

### F214 — `sizeof(Array<uint64, 8>)` does not parse

Severity: **medium (loud refusal of legal C++; the workaround is a type alias)**.

Repro and control: `corpus/solidity-port/triage/F214-sizeof-template-comma/NOTES.md`. Corpus rows:
`layout/SizeofMultiArgTemplate__*`, pinned through `expectedVerdict`.

```
error: Expected r_paren but got comma (,) in sizeof expr
```

clang compiles the same file and both spellings — direct and through `using Aliased = Array<uint64, 8>;`
— return 64. Five of this round's layout archetypes measured containers directly and were refused; they
now alias first, which is how the finding was isolated.

### F215 — `SELF.u64._0` is refused; the same read through a copy is not

Severity: **medium (loud refusal; one assignment works around it)**.

Repro: `corpus/solidity-port/triage/F215-self-word-read/NOTES.md`. Corpus rows:
`hostcalls/HostSelfWordDirectRead__*`, pinned.

```
error: unsupported member read [id(4).u64._0]
```

clang compiles it and both the direct read and the copied read return 29 — the contract's own index. The
diagnostic naming `id(4)` suggests the constant is substituted before the member read is considered.

### F216 — harness: a 3,600-tick script reads as a hang

`hostcalls/TimePackedDateAndTime` advanced the simulator 3,600 ticks to move the clock through an hour.
That costs roughly forty seconds per backend, and with four workers competing it exceeded the shard
deadline, so the sweep reported `1 hang`. Re-run alone the cell passes in 59 s. The script now advances
240 ticks, which crosses the same minute and hour boundaries; the re-run is clean at `0 hang`.

Worth recording because of what it looked like: a hang in the scoreboard is otherwise the signature of a
compiler that does not terminate (F210 is exactly that), and this one was a corpus-authoring choice.

## Round 5 suite counts

```
bun run corpus:check      6104 files, 6091 contracts, clean
bun run corpus:analyze    6091 variants, 0 ERROR diagnostics,
                          111 expected-reject or documented-divergence
bun run corpus:sweep -- --tier full --workers 4
                          6091 contracts · 6009 match · 82 not-match · 0 hang
                          median 56ms · wall 274s
```

The 82 non-matching rows are five findings and nothing else: 39 across three F213 archetypes, 32 across
two F203 archetypes (`K12OfComputedExpression` and the new `HostK12ExpressionVersusVariable`), 5
`ShiftRhsWiderThanLhs` (F204), 4 `NsInheritedNamespacedTypedef` (F201) and 2 `DivQpi` (F200). F205, F209,
F211, F212, F214 and F215 are scored as matches through `expectedVerdict`.

Stimulus coverage: 5,706 of 6,091 contracts moved their state digest mid-script, 280 emitted at least one
log, 18 produced at least one trap, **357 made a cross-contract call**, and 100 finished all-zero.

Positive control: planting `uint16: 2 → 4` in `packages/compiler/src/shared/scalar-sizes.ts` turned
**126 of the 708 layout contracts red** (round 4: 57 of 369), and restoring it returned all 708 to green.
Harness controls: 18 pass. `bun run typecheck` (root project): clean.

## What round 5 added

- **156 new archetypes.** By family: integers +48 (casts and promotions, signed boundaries, loops and
  accumulation), namespaces +18 (all of them *value* probes — see below), containers +12 (ring buffer,
  swap-and-pop, checkpoint search, LRU, prefix sums, bitmap allocator, paired tables), layout +13
  (sizeof matrices, offsets by difference, nested arrays, enum and BitArray strides), controlflow +12
  (state machine, retry with backoff, unroll boundary, short-circuit counting), vulnerabilities +12
  (collateral ratio, interest accrual, slippage bound, basis points, health factor, reward index drift,
  first-depositor inflation), hostcalls +13 (digests, K12 over four operand kinds, fee reserve, id word
  accessors), assets +10 (issuance edges, ownership versus possession, name encoding, multi-asset),
  lifecycle +10 (hook interaction and epoch boundaries), logging +8, intercontract +12.
- **Value probes, which is how F213 got its real statement.** Every namespace archetype this round
  declares same-named things whose *values* differ and reads each through its qualified name. Three
  earlier rounds compared struct sizes and offsets, which a mis-resolution between identically shaped
  types cannot disturb — that is why F213 survived to round 4 and why its full shape needed round 5.
- **A shared two-operand skeleton** (`twoOperandArchetype` in `archetypes/common.ts`) that carries the
  `expect` machinery, so a new arithmetic archetype is a spec rather than a contract.
- **Hook locals** and the `--only` analyze filter from round 4 got used heavily; nothing new there.

## Round 5 limitations

- **The oracle problem is unchanged for eleven of the twelve findings.** Both backends still share one
  build gate, one `qpi.h` and one `QubicSimulator`. The hundred-odd `expect` rows are the only assertions
  in 6,091 contracts, and they cover arithmetic — not layout, not containers, not host calls. A bug in a
  shared component still cannot be seen by this method.
- **The native oracle still does not run contracts.** Same sentence as round 4, and it is the same
  outstanding work: `contract_testing.h`, gtest, a registered contract index.
- **Two of this round's three findings were found by *writing* archetypes, not by running them.** F214
  and F215 were compile refusals hit while authoring; the sweep confirmed them but did not discover them.
  That is a reasonable way to find parser gaps and a poor way to find miscompilations, and it says
  something about where the remaining risk is: the sweep is good at what it already knows how to spell.
- **6,091 contracts from 411 archetypes** is 14.8 variants each. The effective sample is still the
  archetype count. Read the contract number as breadth of spellings.

# Round 6 — the third oracle, built and run

Every round so far ended with the same admission: both backends share one build gate, one `qpi.h` and
one `QubicSimulator`, so "N matched" meant *they agreed with each other*. Round 6 removes that caveat
for part of the corpus by running each backend's **artifact** on the runtime core actually uses.

## Round 6 summary — lane 1

- **The WAMR oracle is built and working.** `qubic_wasm_tests` now builds in this container, and the
  existing `cross-host.test.ts` suite passes 8/8 against it — four fixtures × two backends, byte-identical
  contract state between the qinit simulator and core's own WAMR host.
- **F200, F213 and F204 are now confirmed on core's real runtime.** They are not simulator artifacts:
  each backend's wasm reproduces its simulator answer exactly under WAMR.
- **F203 cannot be settled this way**, for a precise and mechanical reason recorded below.
- The regression gate re-ran the committed corpus before any of this landed: **6,009 match / 82
  not-match**, identical to round 5, same rows.

### How the oracle is driven

Core's own gtest `WasmContracts.CrossHostStateEquivalence` (`$QINIT_CORE/test/wasm_contracts.cpp:645`)
loads a qinit-built wasm under WAMR, runs `INITIALIZE` plus a scripted op list, and prints one
`CROSSHOST_OP=<n>:ok:<hex>` or `CROSSHOST_OP=<n>:trap` per op followed by `CROSSHOST_STATE=<hex>`.
`scripts/solidity-port/wamr-probe.ts` drives it per contract and prints the simulator's answer beside it.

Building it needed four flags that are not the defaults, and one package:

```sh
apt-get install -y nasm          # CompilerSetup.cmake requires it even with BUILD_BINARY=OFF
cmake -S . -B build-wasm -G Ninja -DBUILD_TESTS=ON -DLITE_WASM_SC=ON \
      -DTESTNET=ON -DTESTNET_LITE_RAM=ON -DBUILD_BINARY=OFF -DUSE_SANITIZER=OFF -DANT_WALKER=OFF
cmake --build build-wasm --target qubic_wasm_tests
```

`LITE_WASM_SC` refuses to configure without `TESTNET=ON TESTNET_LITE_RAM=ON`.

### The calibration control, run first

An oracle that has never been checked against a known answer is not an oracle. Two controls ran before
any finding was put to it, both from `F200-sint32-div-overflow`:

| control | simulator | WAMR |
| --- | --- | --- |
| `sint32 -6 / 2` — ordinary division, both backends agree | `-3` on both | `-3` on both |
| `sint64 INT64_MIN / -1` — both backends trap | trap on both | **trap on both** |

So WAMR reproduces both a known value and a known trap. Only then were the findings run.

### F200 — confirmed on core's own runtime

```
DivOverflow, script 1:00000080ffffffff   (sint32 INT32_MIN / -1)

  clang       simulator TRAP(engine faulted: Integer overflow)
              WAMR      TRAP(at op 0)
  typescript  simulator 00000080ffffffff 0000000000000000 0100000000000000
              WAMR      00000080ffffffff 0000000000000000 0100000000000000
```

The TypeScript backend's artifact **runs to completion on core's real host** and writes
`result32 = -2147483648`, `calls = 1`, where clang's traps. This is the strongest form the finding has
taken: rounds 1–5 showed the two backends disagreeing in one simulator, round 4 added a native g++
oracle for the `div` definition, and round 6 shows the deployable artifacts themselves behave
differently on the runtime that will execute them.

### F213 — confirmed on core's own runtime

```
TwinEnum, script 1:

  clang       1  2  100  200  200  7  9   5  55
  typescript  100 200 100 200 20000 9 9  55  55
       (WAMR reproduces each backend's row exactly)
```

Both artifacts run cleanly under WAMR and produce the two different answers. The wrong constants are in
the wasm that would be deployed — not an artefact of how the simulator resolves names.

### F204 — confirmed on core's own runtime

```
ConstShift, script 1:0100000000000000fe

  clang       foldedOutOfRange=0     runtimeOutOfRange=2^62   (self-inconsistent)
  typescript  foldedOutOfRange=2^62  runtimeOutOfRange=2^62   (self-consistent)
       (WAMR reproduces each backend's row exactly)
```

Still undefined behaviour and still not a defect in either backend; what round 6 adds is that clang's
self-inconsistency is real on the production runtime, not a folding artefact of the test harness.

### F203 — the oracle cannot reach it, and exactly why

Both backends' artifacts **trap at op 0** under WAMR. That is not a finding: the gtest registers only
five `lhost` natives (`beginFn`, `endFn`, `markDirty`, `acquireScratch`, `releaseScratch`) plus one
`env` assert and three wasi fd shims. It has **no QPI host**. `K12Struct.wasm` imports `lhost.k12`,
which nothing registers, so the call faults — symmetrically, on both sides, which is itself the tell
that it is the harness and not the contract.

Reaching F203 needs either a host shim that implements `lhost.k12`, or route B (core's native
`contract_testing.h`). Both are outstanding.

### A false start worth recording

The first version of the probe gated on the import list: any module importing an unregistered `lhost`
function was marked unreachable. That is wrong, and it briefly hid F200's confirmed result. **WAMR
resolves imports lazily** — an unregistered import only faults when it is actually *called*. The gate
mattered because of an asymmetry: **the TypeScript backend declares all 64 `lhost` imports on every
contract regardless of use, while clang declares only the ones it needs** (3 for `DivOverflow`). Under a
static gate every TypeScript artifact looks unreachable while running perfectly.

That asymmetry was checked for a defect and is **not** one: `validateImports`
(`packages/compiler/src/driver/wasm-inspection/module-validation.ts:30`) requires each import to be a
known `lhost` function with a matching signature, and does not require the set to be minimal. So the
64-import artifact is legal. Recorded as an observation, not a finding.

### Where lane 1 leaves the twelve

| finding | third-oracle status |
| --- | --- |
| F200 | **confirmed under WAMR** (plus round 4's native g++ oracle) |
| F213 | **confirmed under WAMR** |
| F204 | **confirmed under WAMR** |
| F203 | unreachable — needs an `lhost.k12` shim; both sides trap symmetrically |
| F201, F205, F209, F211, F212, F214, F215 | unreachable **by construction** — the divergence is a compile-time refusal, so there is no TypeScript artifact to run |
| F210 | unreachable — hangs the front end; no artifact is produced |
| F208 | not a compiler artifact; it is an engine/simulator defect |

Three of the ten previously-unconfirmed findings now rest on something other than the two backends
disagreeing. Seven of the remainder are unreachable for a structural reason rather than an untried one:
a compile refusal has no artifact, and an oracle that runs artifacts cannot adjudicate it.

## Round 6 summary — lane 4, the name-resolution drill

Lane 4 tested a question the repo's own suite never asks. `name-shadowing.test.ts` and
`namespace-resolution.test.ts` carry 11 tests each, and all 22 are of the form *"does this name
resolve?"* — "custom namespace helper resolves via using namespace", "a loop counter named `i` counts
rather than reading as `i`". Not one puts **two same-named declarations with different values** in
scope and asks *which one* is picked. That is F213's shape, and it is why 143 test files under
`packages/compiler/tests` did not catch a constant name being effectively global.

`scripts/solidity-port/archetypes/namespaces-lookup.ts` adds 12 archetypes that all ask the second
question. Two came back red.

### F217 — a block-scope local shadowing an outer name is refused

Severity: **medium (loud refusal of legal C++; a contract that builds with the default backend fails
to build with `--compiler typescript`)**. Same class as F209, F214 and F215.

Repro and full explanation: `corpus/solidity-port/triage/F217-block-scope-shadow/NOTES.md`.
Corpus rows: `namespaces/NsBlockScopeShadowChain__*`, 12 variants, pinned through `expectedVerdict`.

```cpp
static constexpr uint64 tier = 1;

locals.atOne = tier;            // no local `tier` in scope yet -> the file constant
{
    uint64 tier = 20;
    locals.atTwo = tier;
    {
        uint64 tier = 300;
        locals.atThree = tier;
    }
}
locals.afterBlocks = tier;      // control: the file constant again
```

```
clang      : ACCEPTED  -> 1, 20, 300, 1   (byte-identical on core's WAMR host)
typescript : REJECTED
  error: 'tier' is used before its declaration (or outside the scope that declares it)
  error: 'tier' shadows a declaration in an enclosing scope — locals share one slot per name,
         so shadowing is not supported
```

The second diagnostic is a fair statement of a design limit: the backend's locals model is flat, one
slot per name per entry, so a block cannot introduce its own binding.

**The first is the interesting one.** `locals.atOne = tier` is read *before* any block declares a local
`tier`, so in C++ it unambiguously names the file-scope constant — there is nothing
use-before-declaration about it. Reporting it as one means the block-local declaration is being hoisted
over the whole entry body: the name is bound for the entire function rather than from its declaration
to the end of its block. That hoisting is exactly what C99 block scoping exists to prevent, and it is
what `scoping/c99_scoping_activation.sol` — the Solidity test this was ported from — was written to
pin down. So the refusal is not only "shadowing is unsupported"; the scope model appears to place the
inner declaration in the outer scope, which is what makes the earlier, legal read look invalid.

### F213 gets broader again, and a new pairing

`NsEnumConstantVersusNamespaceConstant` is 16 more red rows on the same rule. An enum constant in one
namespace and a `static constexpr` in another, both fully qualified:

```cpp
namespace AsEnum     { enum Levels { grade = 6 }; }
namespace AsConstant { static constexpr uint64 grade = 900; }

  read                                clang   TypeScript
  AsEnum::grade                           6          900
  AsConstant::grade                     900          900
  AsEnum::grade + AsConstant::grade     906         1800
  AsEnum::grade * AsConstant::grade    5400       810000
```

Round 5 stated F213 as an enum constant colliding with a *file-scope* `constexpr`. This shows the
collision does not need file scope at either end: **two namespaced declarations of the same constant
name collide with each other**, and the later one wins. Both artifacts were run on core's WAMR host and
reproduce their simulator answers exactly, so the wrong constant is in the deployable wasm.

### The ten that stayed green

The other ten lookup archetypes matched: using-declarations picking one of two colliding constants,
using-directives with every read qualified, twin inner namespaces under two outers, a base member
against a file constant, a constant name equal to a struct name, four namespaces read in reverse
declaration order, three kinds of the same name combined in one expression, two enum types in one
namespace, an input field named like a file constant, and a namespace alias. Each carries a
hand-derived `expect` row, so those ten are assertions against the C++ rule and not merely two
backends agreeing.

One of them earned its own note: `NsAliasAndTargetBothNameConstants` shows the namespace-alias
limitation is **broader than round 5 recorded**. Round 5 pinned the two-level `namespace Short =
Long::Inner;`. Even the one-level `namespace Alias = Target;` is refused, with the same explicit
`unsupported construct at '=' — build this contract with clang` diagnostic. Still a declared
limitation rather than a defect, and pinned as one.

### A methodological correction worth recording

F217 was nearly mis-filed as "not a finding". `corpus:analyze` reported the rejection, and the
diagnostic's wording led to an initial assumption that the build gate was shared and therefore both
backends rejected — which would have made the row test nothing. It was marked `expectReject: true` on
that basis.

The sweep is what caught it: it reported `one-side-rejected`, not `both-rejected`. Building the same
file through `buildContractWithClang` and `buildContractWithTypeScript` side by side settled it — the
rule runs only on the TypeScript path, and clang accepts.

There is a trap here for the next round. Checking such a rejection with the **raw** driver
(`compileContractWithTypeScript`) reports ACCEPTED, because the raw driver skips the build gate. Only
the `@qinit/build` wrappers — which is what the sweep uses — show the refusal. A "both backends accept
it" conclusion drawn from the raw driver would have buried this finding twice over.

## Round 6 summary — lane 2, the untouched surface

The Explore pass that was supposed to inventory the QPI surface never reported, so the inventory was
done directly: every method in `qpi_containers.h`, `qpi_context.h`, `qpi_assets.h` and
`qpi_date_time.h` was grepped against every call site in all 411 archetypes. The result is a concrete
never-called list rather than an impression.

**Container methods with zero call sites anywhere in the corpus:**

```
pov  priority  tailIndex  prevElementIndex  getElementIndex  removeByIndex  isEmptySlot
capacity  key  value  hash  init  setMem  addHead  addTail  cleanupIfNeeded
isArraySorted  isArraySortedWithoutDuplicates
```

and five more with exactly **one** call site each: `cleanup`, `setRange`, `rangeEquals`,
`needsCleanup`, `nextElementIndex`.

**Host API with zero call sites:**

| area | never called |
| --- | --- |
| assets | `acquireShares`, `releaseShares`, `numberOfOwnedShares`, `numberOfShares`, `assetName`, `issuer`, `owner`, `possessor`, `issuanceIndex`, `ownershipIndex`, `possessionIndex`, `byIssuer`, `byOwner`, `byPossessor`, `byName`, `byManagingContract`, `ownershipManagingContract`, `possessionManagingContract` |
| IPO | `bidInIPO`, `ipoBidId`, `ipoBidPrice` |
| mining | `computeMiningFunction`, `initMiningSeed` |
| oracle | `queryOracle`, `subscribeOracle`, `unsubscribeOracle`, `getOracleQuery`, `getOracleReply`, `getOracleQueryStatus`, `getOcInvocationStatus`, `invokeOc` |
| governance | `setShareholderProposal`, `setShareholderVotes` |
| date/time | `addDays`, `addMillisec`, `addMicrosec`, `daysInMonth`, `isLeapYear`, `durationDays`, `setDate`, `setTime`, `getYear`/`Month`/`Day`/`Hour`/`Minute`/`Second`/`Millisec`, `now` |
| safe math | `addAndComputeCarry`, `addWithoutOverflow` |

The asset gap is the one that should be uncomfortable: **F69** and **F82** in campaigns 6 and 7 were
both in `acquireShares` / `releaseShares` / `PRE_RELEASE_SHARES`, and this corpus has never called any
of them.

### What lane 2 actually covered: Collection

`Collection` was the least-covered container by a wide margin — one archetype using `add`,
`headIndex(pov)`, `nextElementIndex`, `element` and `population()`, and nothing else. It is also the
most intricate: a set of priority queues keyed by point of view, each a **binary search tree** whose
parent/left/right indices `add` and `remove` rebalance through `_rebuild`, `_moveElement` and
`_updateParent`. The backward walk and the priority-bounded lookups follow tree edges the forward walk
never touches.

`scripts/solidity-port/archetypes/containers-collection-pov.ts` adds four archetypes over exactly
those methods:

- `CollectionBackwardWalkByTailIndex` — `tailIndex()` + `prevElementIndex()` against
  `headIndex()` + `nextElementIndex()`, asserting the two walks cover the same elements and mirror
  each other's ends.
- `CollectionPovAndPriorityReadBack` — `pov()` and `priority()`, which read the container's own
  bookkeeping back through an element index rather than reading a stored value.
- `CollectionPriorityBoundedLookup` — the two-argument `headIndex(pov, maxPriority)` and
  `tailIndex(pov, minPriority)`, plus bounds outside the range entirely.
- `CollectionPopulationAcrossTwoPovs` — `population(pov)` against `population()` with elements split
  across two points of view.

Three carry hand-derived `expect` rows, so they assert against the C++ rule rather than only against
the other backend.

**The rest of the never-called list is not covered, and that is the honest state of lane 2.** The
asset, oracle, IPO, mining, governance and date/time surfaces named above remain at zero call sites.

## Round 6 summary — lane 3, the deliberate parser attack

Lane 3 was scoped as a **refusal family**: archetypes that deliberately spell the constructs previous
rounds worked around, each pinned through `expectReject` / `expectedVerdict` so a refusal becomes a
standing row instead of a note in a commit message. **That family was not built this round.**

What the round produced instead is two refusals found the same way F214 and F215 were — by writing
code that happened to hit them — and one methodological result that makes the lane worth building
properly next time:

- **F217** (above) is a refusal, found by lane 4 rather than by a lane aimed at refusals.
- **The namespace-alias limitation is broader than round 5 recorded.** Round 5 pinned the two-level
  `namespace Short = Long::Inner;`. `NsAliasAndTargetBothNameConstants` shows even the one-level
  `namespace Alias = Target;` is refused.
- **The raw driver hides refusals.** `compileContractWithTypeScript` reports ACCEPTED for F217's
  contract; only `buildContractWithTypeScript` — the `@qinit/build` wrapper the sweep uses — runs the
  gate that refuses it. Any future refusal hunt has to go through the wrappers, or it will conclude
  that constructs are accepted when the real build path rejects them. This nearly buried F217.

The hang guard the lane called for was also not built. It remains a prerequisite for generating
refusal candidates safely, because F210 (real non-termination) and F216 (a slow script) both score as
`hang` and nothing yet distinguishes them.

## Round 6 suite counts

```
bun run corpus:check      6333 files, 6321 contracts, clean
bun run corpus:analyze    6321 variants, 0 ERROR diagnostics,
                          139 expected-reject or documented-divergence
bun run corpus:sweep -- --tier full --workers 3
                          6321 contracts · 6223 match · 98 not-match
                          0 expect-violation · 0 hang
```

The 98 non-matching rows are five findings and nothing else:

| finding | rows | archetypes |
| --- | ---: | --- |
| F213 | 55 | `NsEnumConstantVersusNamespaceConstant` 16, `NsEnumConstantVersusFileConstant` 13, `NsTwinEnumsAcrossFourNamespaces` 13, `NsTwinEnumSameConstantNames` 13 |
| F203 | 32 | `K12OfComputedExpression` 17, `HostK12ExpressionVersusVariable` 15 |
| F204 | 5 | `ShiftRhsWiderThanLhs` |
| F201 | 4 | `NsInheritedNamespacedTypedef` |
| F200 | 2 | `DivQpi` |

F205, F209, F211, F212, F214, F215 and **F217** are scored as matches through `expectedVerdict`: they
pass by diverging exactly as documented and fail the moment they stop.

**Positive control:** planting `uint16: 2 → 4` in `packages/compiler/src/shared/scalar-sizes.ts`
turned **126 of the 708 layout contracts red** (round 5: 126 of 708 — unchanged, as expected, since
round 6 added no layout archetypes), and restoring the line returned all **708 to green**.

**The secondary oracle caught three of my own errors again.** The first full round-6 sweep reported
**47 expect-violations** across three of the four new Collection archetypes — both backends agreeing
with each other and both disagreeing with me. All three were one mistake repeated: I assumed the
per-pov priority queue walks ascending. It walks descending, and core says so outright at
`qpi_collection_impl.h:64` — *"here, head's priority > maxPriority >= tail's priority"*.

The direction was re-derived from that source rather than adopted from the observed output, so the
corrected rows remain assertions rather than a restatement of whatever the backends produced. A fourth
row was then derived from the same comment **before** running it — `headIndex(SELF, 4) -> 20`,
`tailIndex(SELF, 4) -> 30`, out-of-range bounds `-> 0` — and held on first contact. Round 5 caught
eleven such errors, round 6 three; that is now three rounds in which the only assertions in the corpus
have found authoring mistakes that backend-agreement could never have surfaced.

## Round 6 limitations

- **The oracle problem is narrowed, not closed.** Three findings (F200, F213, F204) now rest on core's
  real WAMR runtime rather than on two backends agreeing. The other nine do not, and seven of them
  *cannot* through this route: a compile refusal produces no artifact to run. F203 needs an
  `lhost.k12` shim; F210 produces no artifact at all.
- **"6,223 matched" still means the two backends agreed with each other** for every row without an
  `expect`. The ~110 `expect` rows remain the only correctness assertions in 6,321 contracts, and they
  cover arithmetic, name resolution and now four Collection methods — not layout, not host calls, not
  cross-contract.
- **The WAMR route only reaches contracts that never call an unregistered host function.** The gtest
  registers five `lhost` natives; everything else faults when called. That excludes hostcalls, assets,
  logging, cross-contract and anything hashing — by construction, not by omission.
- **Lane 2 covered `Collection` and nothing else on its own list.** The asset, oracle, IPO, mining,
  governance and date/time surfaces named above are still at **zero call sites**, and the asset gap
  overlaps two findings from earlier campaigns (F69, F82).
- **Lane 3 was not built.** No refusal family, no hang guard. F217 and the broader namespace-alias
  limitation were found by lane 4 and by authoring, which is the same accidental route that produced
  F214 and F215 — reasonable for parser gaps, poor for miscompilations.
- **Nothing here has been run against a live node.** WAMR-under-gtest is core's runtime, not core's
  node: no consensus, no ticking, no real spectrum. F73 and F68 in earlier campaigns were both node-level
  defects that no in-process harness would have seen.

## Round 6 — the simulator-parity sweep, and F218 (harness)

The confirmations above answer "is this finding real on core's runtime?". The sweep in
`scripts/solidity-port/wamr-sweep.ts` asks a different and, for the campaign's central limitation, more
important question — of each backend separately rather than of the pair:

> does this artifact behave the same way on the qinit simulator and on core's real WAMR host?

A contract where both backends agree with each other **and both differ from WAMR** is precisely the
class of defect no previous round could have produced, because it lives in the component the two
backends share.

### F218 — harness: the sweep's TypeScript path used the raw driver and manufactured 28 false positives

Severity: **n/a (defect in this campaign's own tooling)**. Recorded for the same reason as F202, F206,
F207 and F216 — and with more embarrassment, because F217's own notes had already written the warning
down one commit earlier.

The first parity run reported `624 agree · 118 shim-trap · 28 DISAGREE`. All 28 were TypeScript-side,
all on the two archetypes that are *pinned as one-side-rejected* — F217's `NsBlockScopeShadowChain`
and `NsAliasAndTargetBothNameConstants` — and every one read:

```
DISAGREE  typescript  namespaces/NsBlockScopeShadowChain__0939
            simulator DEPLOY-FAILED(unexpected end of module)
            WAMR      NO_STATE
            imports   0 lhost, 0 unregistered
```

Zero imports and "unexpected end of module" is an **empty artifact**. The sweep built its TypeScript
side with the raw `compileContractWithTypeScript` driver, which **skips the build gate**; for a
contract the gate refuses, it returns an empty module rather than failing. The sweep then dutifully
compared that empty module against WAMR and called the difference a divergence.

This is exactly the trap F217's `NOTES.md` describes — *"checking a rejection with the raw driver
reports ACCEPTED, because the raw driver skips the build gate"* — written after that trap nearly buried
F217, and then walked into again in a different tool in the same round. The fix is one import:
`buildContractWithTypeScript`, the same wrapper the main sweep uses. Re-running the namespaces family
afterwards turns all 28 into `build-rejected` and leaves **zero** disagreements.

The general lesson is worth more than the specific one: **any tool in this harness that builds a
contract must go through the `@qinit/build` wrappers.** The raw drivers silently model a different,
more permissive compiler than the one the sweep, the CLI and the chain actually use.

To be precise about the scope of that, since it was later measured rather than assumed: the difference
is in **acceptance, not codegen**. For a contract the gate accepts, the two paths emit byte-identical
wasm (`ArrayOfIdStride__base`: 4,744 bytes and the same 64 `lhost` imports either way), which is what
round 2 found when it moved the whole harness onto the wrappers. The raw driver is dangerous because it
returns an empty module for a contract the gate refuses instead of failing — not because it compiles
accepted contracts differently.

### What the parity sweep found

Nothing — and that is a result worth stating precisely rather than burying.

```
385 contracts across 7 families · 770 artifact runs
  590  agree           simulator and core's WAMR host produce byte-identical state
  152  shim-trap       the contract calls a host function the gtest does not register
   28  build-rejected  the TypeScript build gate refuses the contract (F217, alias)
    0  DISAGREE
```

For every contract that can actually be executed on both, **the qinit simulator and core's own runtime
agree byte-for-byte**. That is the first direct evidence in six rounds about the shared component the
campaign has been warning about since round 1 — "both execute in the same `QubicSimulator`, so N
matched means they agreed with each other". For the pure-state subset, the simulator is now shown to be
faithful to the real host rather than merely self-consistent.

The internal consistency check that makes the run credible: the shim-trap set is **76 contracts on
clang and the same 76 on the TypeScript backend — an identical set**, and there is no contract where
one backend agrees and the other does not (outside the 28 the gate refuses). Whether a contract can run
under a five-native shim is a property of *the contract*, not of who compiled it, and that is exactly
what the measurement shows.

Two honest bounds:

- **The 152 shim-traps are not covered.** Anything calling `qpi.K12`, a transfer, the clock, the asset
  API or another contract cannot run under this harness, so the simulator's fidelity there is still
  unmeasured — and that is where F71, F82 and F69 (earlier campaigns) all lived.
- **A sample, not a census.** 55 contracts per family, 385 of 6,321, and the pure-state families only;
  hostcalls, assets, logging and intercontract were excluded by construction.

#### This table is the second one. The first was wrong, and how it was wrong matters.

An earlier version of this section published `624 agree · 118 shim-trap · 28 build-rejected · 0
DISAGREE` and presented it as one clean run. It was not: it was the *first* parity run's tally with the
28 DISAGREE rows reclassified by hand after F218 was fixed and re-verified on the namespaces family
alone. A container restart then killed the confirming re-run before it finished, and the derived table
went out as though it were observed.

Re-running it cleanly moved **34 rows** — `624 → 590` agree, `118 → 152` shim-trap. Only the headline
survived unchanged.

The cause is not the F218 build-path fix. That was checked rather than assumed: building
`ArrayOfIdStride__base` through the raw `compileContractWithTypeScript` driver and through
`buildContractWithTypeScript` produces **byte-identical wasm** — 4,744 bytes, the same 64 `lhost`
imports — which matches round 2's finding that the wrapper does not change the artifact for a contract
the gate accepts. The build path cannot explain the shift.

What explains it is that **the first parity run read the corpus while `generate.ts` was rewriting it**.
It was launched as a background job and left running across two regenerations (commit `08abe9f`, which
fixed the three wrong Collection `expect` rows, is one of them). Its inputs changed underneath it. The
asymmetric shim-trap split that run produced — 76 on clang against 42 on TypeScript, for a property
that cannot depend on the backend — is the fingerprint of exactly that, and is the thing that should
have been questioned at the time.

Two lessons, both cheap and both learned the expensive way this round:

1. **Never run a sweep against the corpus while anything can regenerate it.** The harness has no lock,
   and a partially-rewritten corpus produces plausible numbers rather than an error.
2. **A derived number must be labelled as derived.** The reclassification reasoning was sound and the
   conclusion held, but publishing it in the shape of an observation is how a campaign that exists to
   distrust agreement ends up trusting its own arithmetic.

# Round 7 — the third oracle was measuring one backend twice

Round 6 ended by claiming the campaign had finally broken its central limitation: that both backends
execute in the same `QubicSimulator`, so "they matched" only ever meant they agreed with each other.
The claim rested on a parity sweep against core's own WAMR runtime.

**That sweep never ran clang.** Round 7 opens by withdrawing its table.

## F219 — harness: the parity sweep compared one artifact with itself

Severity: **high (a published result was wrong, and the check offered as its validation was the
defect's own signature)**.

`buildContractWithClang` writes `join(outDir, "<contractName>.wasm")`
(`packages/build/src/compile/clang.ts:275`) and `buildContractWithTypeScript` writes the same path
(`packages/build/src/compile/typescript.ts:170`). `wamr-sweep.ts` passed both the same `outDir` and the
same contract name. TypeScript built second, overwrote clang's artifact, and the run loop then read
that one file twice — once labelled `clang`, once labelled `typescript`.

Three independent confirmations:

- Of the 385 contracts where both backends built, **357 produced byte-identical `simulator` *and*
  `wamr` strings**. The only 28 rows that differed are the ones where the TypeScript build was refused
  by the gate and never wrote a file at all.
- `AccountBookWithIterationOrder`'s surviving clang artifact imports exactly the five registered
  natives — **zero unregistered** — yet its clang row is `shim-trap`, a verdict the code can only reach
  when `unregisteredImports(wasm).length > 0`. Structurally impossible unless the bytes being
  classified were the TypeScript module's.
- Same for `ArrayOfHashMaps`.

So the published `590 agree · 152 shim-trap · 28 build-rejected · 0 DISAGREE` describes the TypeScript
artifact twice, and **real clang coverage under the third oracle was zero**.

The part worth dwelling on is the validation. Round 6 offered this as the run's internal consistency
check:

> the shim-trap set is **76 contracts on clang and the same 76 on the TypeScript backend — an
> identical set**

and reasoned that since whether a contract can run under a five-native shim is a property of the
contract rather than of who compiled it, the identical sets showed the measurement was sound. But the
two backends emit *different imports*: clang inlines KangarooTwelve into the module as a header-only
static (`core-lite/src/kangaroo_twelve.h:1395`), while the TypeScript backend lowers it to `$lh_k12`
(`packages/compiler/src/backend/wasm/calls/host-intrinsic-call.ts:113`). The sets should **not** have
matched, and their matching was the clearest possible evidence of the collision. A number was read as
confirming the result when it was in fact the disproof.

This is the third round-6/7 defect caught by *a classification looking wrong* rather than by reading
code, and the second caused by an assumption about artifact paths — F218 was the first, and its NOTES
warned about exactly this family one commit earlier.

**Fix.** Each backend gets its own output directory, plus a guard that aborts the sweep if two
independently-produced artifacts are ever byte-identical — the condition that would have caught this on
day one. With the fix, `ArrayOfArraysStride` builds to 17,335 bytes under clang and 4,898 under the
TypeScript backend, and both agree with WAMR.

## Lane 1 — widening the oracle, and why the shim is a patch in this repo

The gtest registered five natives, so 152 of 770 round-6 runs (~20%) trapped for want of an import
rather than because anything was wrong. Two natives close the whole gap: `k12` accounts for 122 of the
152 and `tick` for the other 30.

`scripts/solidity-port/wamr-shim.patch` adds `k12`, `tick`, `epoch`, `initialTick`,
`numberOfTickTransactions`, the seven clock readers, `now`, and `pauseLog`/`resumeLog`, and populates
the guest context struct at `ctx_addr()`. Every constant mirrors a bare `QubicSimulator` — tick 0,
epoch 0, clock pinned to 2024-01-01T00:00:00Z — because the sweep compares this runtime *against* that
simulator, and a shim answering anything else would manufacture divergences rather than reveal them.

Deliberately **not** shimmed: transfers, the asset ledger, logging, inter-contract calls, IPO, mining
and the oracle. Those need real host state, and a stub that invents an answer converts "this contract
is unreachable" into "this contract silently agreed", which is strictly worse for an oracle than a
trap.

Three implementation notes worth keeping:

- **K12 lives in its own translation unit** (`test/wasm_k12_shim.cpp`). `kangaroo_twelve.h` reaches
  `platform/memory.h`, whose non-`NO_UEFI` branch resolves `setMem`/`copyMem` through the UEFI
  boot-services pointer, which no test binary links. Defining `NO_UEFI` inside `wasm_contracts.cpp`
  would have changed that whole translation unit's view of every core header it already includes.
- The shim was **checked against the engine before being trusted**: core's `KangarooTwelve(in, len,
  out, 32)` and the engine's `k12Sync` both return
  `ad9111ae9ae7ce1ad1139d6060d42ad386c5fbc23f74ecc26e28ed4c0876f47f` for the same four input bytes.
  The plan flagged a length mismatch as the way this shim could manufacture agreement; both are 32
  bytes fixed.
- The `ctx_addr()` fix closes a hole the shim-trap classifier could not see at all.
  `qpi.invocator()`, `originator()` and `invocationReward()` are **struct reads, not lhost calls**, so
  they never trapped — they silently answered zero.

**core-lite is never committed to.** It is treated as a scratch build tree: the patch is owned by this
repo, `build-wamr-oracle.sh` applies it with a reversibility check before configuring, and core-lite's
HEAD stays where it was. The built binary does not survive a container restart; the patch does.

Recalibrated after patching — `bun test packages/cli/tests/integration/cross-host.test.ts`, 8 pass. An
oracle that has been modified and not re-checked against a known answer is not an oracle.

## F220 — the asset iterators discard their filters

Severity: **high (silent wrong answer, no diagnostic, in fund-accounting code)**.

Corpus rows: `assets/AssetOwnershipIteratorOwnerFilterIgnored__*`,
`assets/AssetPossessionIteratorPossessorFilterIgnored__*`,
`assets/AssetOwnershipIteratorSurvivesEmptyFilter__*`, all pinned through `expectedVerdict`.

`packages/compiler/src/backend/wasm/calls/containers.ts:523` lowers `begin()` as

```ts
const selN = watIr.rawWatNode(context.lowering.materializeSelect(context, undefined), WatNodeType.I32);
```

— unconditionally the `any()` selector — and then passes that same buffer for **both** the ownership
and the possession parameter of `$lh_assetEnumerate`. `expression.callArguments[1]` and `[2]` are never
read. Only `callArguments[0]`, the asset, survives.

So this compiles, runs, returns no error, and enumerates every holder:

```cpp
locals.iter.begin(locals.asset, AssetOwnershipSelect::byOwner(locals.other));
```

Measured on a contract that issues 1000 shares and transfers 400 away, so two holders exist:

| | filtered count | filtered shares | unfiltered count | unfiltered shares |
| --- | --- | --- | --- | --- |
| clang | 1 | 400 | 2 | 1000 |
| typescript | **2** | **1000** | 2 | 1000 |

The unfiltered control agrees on both backends, which is what isolates the cause to the discarded
filter rather than to the iteration.

Two things sharpen this. First, **the machinery to do it right exists and is used correctly elsewhere
in the same compiler**: `qpi.numberOfShares(asset, AssetOwnershipSelect::byOwner(holder))` returns
1000 / 400 / 0 for total / holder / stranger on *both* backends. `materializeSelect` works when handed
a real expression; `begin` simply never hands it one. Second, the consequence is not a crash but a
number: a dividend distributor or a snapshot routine written against this iterator would credit one
holder with every holder's balance.

The same function silently returns `null` — falling through to whatever handles an unrecognised call —
for `issuer()`, `assetName()`, `asset()`, `issuanceIndex()`, `ownershipIndex()`, `possessionIndex()`
and `possessionManagingContract()`, and the gate at `:508` does not recognise `AssetIssuanceIterator`
at all.

## Lane 2 — `DateAndTime`, a surface with ground truth

Round 6's inventory found `addDays`, `addMillisec`, `addMicrosec`, `daysInMonth`, `isLeapYear`,
`durationDays`, `setDate`, `setTime` and every `get*` accessor at **zero call sites** across all 411
archetypes. The one near-miss, `hostcalls-time.ts:465`, hand-packs its own non-QPI bit layout and never
constructs a `DateAndTime`.

`scripts/solidity-port/archetypes/integers-datetime.ts` adds ten archetypes carrying **40 hand-derived
`expect` rows**. What makes this lane unusually strong: the TypeScript backend does not reimplement any
of it — `packages/compiler/src/generated/qpi-snapshot.ts` embeds core's `qpi_date_time.h` verbatim and
the backend compiles those bodies — so everything except `qpi.now()` is pure guest computation, a
divergence would be codegen rather than a host-model mismatch, and *the answer has ground truth*. A
leap year is a leap year, so the rows assert against the C++ rule instead of only against the other
backend.

What the rows pin, each cited to `qpi_date_time.h`:

- **`setDate` and `setTime` do not mask their arguments** (`:84`, `:99`). Month 20 is five bits against
  a four-bit field, so `20<<42` sets bit 46 — the year's bit 0 — and the date reads back as year 1,
  month 4. Day 40 bleeds into the month the same way; hour 40 bleeds into the day.
- **`getYear` is the only accessor with no mask** (`:108`). Year 65536 lands entirely on a reserved bit
  and reads back as **0**; year 131071 reads back as 65535, indistinguishable from a legal value.
- The full leap ladder (0, 4, 100, 400, 1900, 2000, 2023, 2024, 65535) and the `daysInMonth` table
  including its out-of-range guard, where month 0 and month 13 both answer **0** — the value that makes
  `add()` misbehave on a corrupt month.
- `add()`'s single-day step across a leap boundary, and its `isValid()` guard, which refuses every day
  arithmetic on a default-constructed instance before touching a field.

Two archetypes carry **no** rows on purpose. The eight-argument `add()` folds five carries through
`addAndComputeCarry` and then hands off to a 160-line day loop with a 400-year fast path; deriving that
by hand is precisely what produced 47 false violations in round 6. Those rest on the two backends and
the WAMR oracle, and the file says so.

The rows were checked to be *live*: planting a deliberately wrong value in the leap-year ladder turns
the cell `expect-violation`, so the ten green results mean the rows ran, not that they were skipped.

## Lane 3 — tombstones, the removal counter, and cleanup's three exits

The only removal call site in all 411 archetypes was `removeByKey`, three times. `removeByIndex`,
`getElementIndex`, `isEmptySlot`, `key`, `value`, `nextElementIndex`, `cleanup`, `cleanupIfNeeded`,
`needsCleanup`, `capacity`, `reset` and `HashSet::remove` had **zero**.

`scripts/solidity-port/archetypes/containers-hash-removal.ts` adds eight archetypes with **29
hand-derived rows**. Every one keys on `id`, and that is load-bearing rather than incidental:
`HashFunction<m256i>::hash` is `key.u64._0` verbatim (`qpi_hash_map_impl.h:26`) with no K12 in the
path, so `id(k,0,0,0)` lands in slot `k & (L-1)` and a collision chain can be laid out by hand. With a
`uint64` key the hash goes through KangarooTwelve and a row could only assert behaviour, never
position.

Pinned behaviour:

- **Tombstone traversal.** Keys 0, 8 and 16 chain into slots 0, 1, 2 of an 8-slot map. Removing the
  middle still finds the tail, because `getElementIndex` (`:66`) has no `case 2` and walks through a
  `0b10` while a `0b00` stops it.
- **`removeByIndex` masks and never validates** (`:229`). Index 8, index 2^40 and index −1 are all
  silent aliases; −1 selects slot 7, and because slot 7 is unoccupied the occupancy guard makes the
  whole call a no-op — the same observable outcome as a legal index into an empty slot, which is what
  makes the missing bounds check hard to notice.
- **`_markRemovalCounter` counts removals, not tombstones** (`:156`). Churning one key five times leaves
  a map holding exactly one element in one slot with zero slots marked for removal — and
  `needsCleanup(50)` returns true.
- **The threshold truncates.** `percent * L / 100` on an 8-slot map is 0 for every percentage up to 12
  and 1 at 13, so a nominal 10% policy behaves identically to 0%.
- **All three `cleanup()` exits** (`:279`): the immediate return when nothing was removed, the
  `reset()` that zeroes the whole object when everything was, and the scratchpad rehash otherwise —
  which *moves* a surviving key from slot 2 to slot 1, so compaction is observable as a changed index.
- `isEmptySlot` returns **true for a tombstone**, `key()`/`value()` ignore occupancy and read back the
  zeroes `removeByIndex` wrote, and `HashSet::key` returns by value where `HashMap::key` returns by
  reference.

**Two rows in the first draft were wrong, and the harness caught them.** Both were mine, not the
compilers': the `Run` procedure is invoked once per operand pair against the same `StateData`, so the
removal counter accumulated across pairs and each row was silently a function of the ones before it.
Resetting the container at the top of each body makes every pair independently derivable. Same class of
error as round 6's 47 — a derivation that forgot its own context — and again caught by a red cell
rather than by inspection.

A claim from the exploration that did **not** survive checking, recorded because it nearly became an
archetype: `_getEncodedOccupationFlags` (`:36`) was reported to shift by `2 * _nEncodedFlags - offset`
and reach ≥ 64 for `L < 32`, which would be UB in C++ and defined in wasm. It cannot. That shift is
only taken when `offset > 0`, and reaching 64 needs `offset <= 2*nEnc - 64`, which is negative for
every `L <= 32` and zero at `L = 64`. No legal capacity admits it.

## Lane 4 — partially delivered

The iterator half is done and produced F220 above, plus `AssetNumberOfSharesWithSelectors`, which
establishes that the selector machinery is correct when it is actually invoked.

**The share-management half was not built.** `acquireShares`, `releaseShares` and the four
`PRE_/POST_ACQUIRE/RELEASE_SHARES` callbacks remain at zero call sites, as they have been for seven
rounds — and they are where F69 (campaign 6) and F82 (campaign 7) both lived. Reaching them needs an
emitter change first: `ContractSpec` (`scripts/solidity-port/emit.ts:34-100`) exposes only `initialize`
and the four tick/epoch hooks, and the hook loop at `:383-391` iterates exactly
`["BEGIN_TICK","END_TICK","BEGIN_EPOCH","END_EPOCH"]`. That change touches every archetype's code path,
and starting it late in a round with a corpus regeneration and two sweeps still to run was the wrong
trade. It is the first thing round 8 should do.

## The parity table, measured for the first time on both backends

Sample: 15 variants per family across the seven pure-state families, run against core's own WAMR
runtime through the repaired sweep and the widened shim.

```
105 contracts across 7 families · 210 artifact runs
  195  agree           simulator and core's WAMR host produce byte-identical state
   15  build-rejected  the TypeScript build gate refuses the contract (F217, the namespace alias)
    0  shim-trap
    0  DISAGREE
```

By backend: **clang 105 agree** — every contract built and ran — and **typescript 90 agree, 15
build-rejected**. The 15 are the gate-refusal family clang accepts and the TypeScript backend does not,
already recorded as F217 and the alias limitation.

Three things this establishes that round 6's table did not.

**clang has now actually been measured.** All 105 clang artifacts were executed on core's real runtime
and every one produced the same state as the qinit simulator. Under the collided sweep that number was
structurally zero, whatever the table said.

**The shim gap is closed: 152 of 770 runs (~20%) became 0 of 210.** Nothing in this sample is
unreachable any more. That is the widened shim doing exactly what it was added for — `k12` for the
hash-keyed and `qpi.K12` contracts, `tick` for the lifecycle ones.

**The artifact-collision guard did not trip**, so the 105 pairs are genuinely distinct modules. Their
*final states* still match, which is the correct invariant — same contract, same semantics — but they
now reach it through different bytes: 17,335 bytes under clang against 4,898 under the TypeScript
backend for `ArrayOfArraysStride`. Round 6 could not have told those two facts apart.

And it is a first, real cross-check of two independent KangarooTwelve implementations: clang inlines
core's header-only K12 into the module, while the TypeScript backend calls out to `lhost.k12`, which
the shim answers with core's. The hash-keyed container contracts exercise both and agree.

Two bounds, stated plainly:

- **This is a smaller sample than round 6's** — 105 contracts against 385, 15 per family rather than
  55, chosen because the sweep was competing with the full differential run for four cores. It is a
  sample, not a census, and the families outside the pure-state seven (hostcalls, assets, logging,
  intercontract) are excluded by construction as before.
- **The unshimmed surface is still unmeasured.** Transfers, the asset ledger, logging and
  inter-contract calls remain outside the oracle by choice, and F220 lives in exactly that region — it
  was found by reading the backend and confirmed by the two-backend differential, not by this oracle.

## F221 — `addMillisec` silently drops the day carry

Severity: **high (silent wrong answer in date arithmetic; the call reports success)**.

Repro: `corpus/solidity-port/triage/F221-addmillisec-day-carry/NOTES.md`. Corpus rows:
`integers/DateAddMillisecCarryChain__*`, six variants, currently unpinned.

From `2024-01-01 00:00:00.000`:

| `addMillisec(n)` | clang | typescript |
| --- | --- | --- |
| 86,399,999 — one ms short of a day | 2024-01-01 23:59:59.999 | same |
| **86,400,000 — exactly one day** | **2024-01-02** 00:00:00.000 | **2024-01-01** 00:00:00.000 |
| **172,800,000 — two days** | **2024-01-03** 00:00:00.000 | **2024-01-01** 00:00:00.000 |

It returns **true** in every row on both backends. Nothing reports a problem.

The boundary is exact. Everything below a full day agrees, and the divergence appears the moment the
carry chain has to produce a day; two days lose two days, so the carry is discarded rather than
truncated or wrapped. `addMillisec` (`qpi_date_time.h:515`) forwards to the eight-argument `add()` at
`:271`, which carries micro → milli → sec → minute → hour, writes the time with `setTime`, and then —
only if the resulting day carry is non-zero — folds it into `days` and tail-calls the three-argument
`add()` to move the date. Everything through `setTime` matches; the date half does not run.

**The secondary oracle could not have caught this, and the differential did.**
`DateAddMillisecCarryChain` is one of the two archetypes in `integers-datetime.ts` deliberately shipped
*without* hand-derived `expect` rows, on the grounds that folding five carries into a 160-line day loop
is exactly the arithmetic that produced 47 false violations in round 6. That judgement was right — and
the finding still landed, because the two backends disagreed. It is the clearest argument this campaign
has produced for keeping both oracles rather than treating expect rows as the stronger one.

## Round 7 suite counts

```
6,618 contracts · 6,514 match · 104 not-match · 0 hang · 0 expect-violation · median 811 ms
```

Round 6 was `6,321 · 6,223 match · 98 not-match · 0 expect-violation`. The 22 new archetypes added 297
contracts, and the difference in the red column is **exactly the six `DateAddMillisecCarryChain`
variants** — F221. Everything else diverging is a finding already on the books:

| rows | verdict | archetype | finding |
| --- | --- | --- | --- |
| 17 | step-mismatch | `K12OfComputedExpression` | F203 |
| 16 | step-mismatch | `NsEnumConstantVersusNamespaceConstant` | F213 |
| 15 | step-mismatch | `HostK12ExpressionVersusVariable` | F203 |
| 13 | step-mismatch | `NsEnumConstantVersusFileConstant` | F213 |
| 13 | step-mismatch | `NsTwinEnumsAcrossFourNamespaces` | F213 |
| 13 | step-mismatch | `NsTwinEnumSameConstantNames` | F213 |
| **6** | **step-mismatch** | **`DateAddMillisecCarryChain`** | **F221, new** |
| 5 | step-mismatch | `ShiftRhsWiderThanLhs` | F204 |
| 4 | one-side-rejected | `NsInheritedNamespacedTypedef` | F201 |
| 2 | trap-divergence | `DivQpi` | F200 |

**0 expect-violation across the whole corpus.** That covers roughly 179 hand-derived rows — about 110
carried from earlier rounds and **69 new this round**, 40 in `integers-datetime.ts` and 29 in
`containers-hash-removal.ts`. Every one asserts against a quoted C++ body rather than against the other
backend, and all of them hold.

The three asset-iterator archetypes score `match` because they are pinned through `expectedVerdict`:
they diverge exactly as F220 documents, so a green row means the defect is still there and a red one
would mean it had been fixed or the harness had gone blind.

`corpus:check` is clean at 6,630 files / 6,618 contracts, and `typecheck` is clean.

## Positive control

```
planted `uint16: 2 -> 4` in packages/compiler/src/shared/scalar-sizes.ts
  708 layout contracts · 582 match · 126 not-match
restored
  708 layout contracts · 708 match ·   0 not-match
```

126 of 708, the same number round 6 measured. A round that cannot show its harness still detects a
known planted bug has not measured anything, and this one can.

## What round 7 did not do

- **The share-management callbacks are still at zero call sites.** `acquireShares`, `releaseShares` and
  the four `PRE_/POST_ACQUIRE/RELEASE_SHARES` hooks — where F69 and F82 both lived — need an
  `emit.ts` `ContractSpec` change that touches every archetype's code path. Round 8's first task.
- **The parity sample shrank**, 385 contracts to 105, because the sweep was competing for four cores
  with the full differential run. The parallelism added this round makes a larger sample affordable
  next time; it was added too late to help this one.
- **Lane 5 was not run.** Quantifying the corpus's mutation-kill rate against the existing unit suite,
  and scaling `tools/fuzz-gen.ts` past its ~20 pinned seeds, both remain open. They are the two
  measurements that would tell us what this corpus is actually worth, as opposed to how large it is.
- **`oracle`, IPO, mining and governance** remain unshimmed and uncalled, by choice on both counts.

## The lesson this round is actually about

Round 6 published a table, offered a consistency check for it, and the check was the defect's own
fingerprint. Round 7 opened by withdrawing that table and closed by finding F220 through *reading a
lowering function* and F221 through *an archetype deliberately shipped without an expect row*.

Three different routes to three different findings, and none of them was the thing the campaign
nominally does — sweep a large corpus and look at the red column. The corpus's contribution was to make
F221 reproducible across six variants and to prove F220 is not a fluke of one contract. That is worth
having. But the finding rate per hour was far higher for "read the code that lowers the feature nobody
has called" than for "generate another thousand contracts", and the next round should be weighted
accordingly.

# Checked against main — 0 of 15 fixed

Main moved from `bf53045` (this branch's point) to **`0d0153c`**, five commits, including
`df4912b fix 32 findings across the CLI, build, compiler, engine and editor`. The question is whether
any of this campaign's findings are already fixed there.

Method: every triage repro rebuilt with **main's own compiler**, both backends, from a worktree of
`origin/main` whose `@qinit/*` imports resolve to main's source (verified — `import.meta.resolve`
returns `/tmp/qinit-main/packages/compiler/src/index.ts`). Same headers, same clang, same core. The
comparison is TypeScript-vs-clang within each checkout, so a fix shows up as a divergence turning into
agreement.

**Control first.** On this branch the runner reports all 14 testable repros diverging, which is what
makes a green row on main meaningful. F210 is excluded from the loop because it hangs the front end and
would take the rest of the run with it; it is timed separately.

```
branch cdf5599   0 agree · 14 diverge
main   0d0153c   0 agree · 14 diverge
```

**Twelve of the fourteen are byte-identical across the two checkouts** — same TypeScript state, same
clang state, same rejection messages. F210 still hangs on both, killed at 120 s.

Two rows moved, and neither is a fix:

| | this branch | main |
| --- | --- | --- |
| F209 `::name` | TypeScript refuses · **clang compiles**, returns 1 | TypeScript refuses · **clang refuses** |
| F217 block shadowing | TypeScript refuses · **clang compiles**, returns 1, 20, 300, 1 | TypeScript refuses · **clang refuses** |

On main the clang path fails on the TypeScript frontend's own diagnostics:

```
compiler IDL analysis failed: line 42: Expected expression but got d_colon (::)
compiler IDL analysis failed: line 64: 'tier' is used before its declaration
```

So the underlying limitation is untouched; it is now enforced on both paths. For a developer that is a
*narrowing*: a contract that is legal C++, that clang compiled, and that the chain would accept, now
builds with neither backend. As a campaign result it also means F209 and F217 stop being
`one-side-rejected` rows and become `both-rejected` — which, as F202 established in round 1, is the
verdict that tells you least.

I did not isolate which of the five commits causes it. The gate refactor in
`build/src/compile/build-rules.ts` splits violations into fatal and warning tables and adds a
`qpi/invocator-in-function` warning, but that rule is unrelated to either repro, and the message comes
from the IDL-analysis step rather than from `buildGateViolations`. Recorded as observed, not explained.

**None of the five root-cause files are touched by main.** `containers.ts`, `host-intrinsic-call.ts`,
`memory-operations.ts`, `binary-expression.ts`, `declaration-index.ts` and `constant-evaluator.ts` are
all unchanged between `bf53045` and `0d0153c`, which is consistent with the empirical result.

## One thing main changed that this campaign should watch

`packages/build/src/compile/clang.ts` **removed `QPI_DIV_SHIM`**. That shim existed because libc++'s
`<stdlib.h>` injects `::div(long long, long long)` globally and the exact match beats the `QPI::div`
template on signed operands. Without it, a bare `div(a, b)` in a contract binds to libc++'s `::div` on
the clang path, which returns `lldiv_t`.

Checked rather than assumed: **the corpus has zero bare `div(` call sites** — all 16 grep hits are in
comments, and the 739 real uses are qualified `QPI::div`. So nothing here regresses, and F200's repro
is unaffected because it also spells the call qualified. Flagged because a contract outside this corpus
that spells it bare now gets a different function on the clang path than it did, and no archetype would
currently notice.

# Verification pass — every unverified fix built and measured

The round-7 register shipped fourteen findings whose fix was `proposed` or `located` and never built.
This pass built all of them. Method for each: prototype in a worktree on top of the three already-validated
patches, run the triage repro through both backends, run the compiler unit suite, and — once all of them
were stacked — run the corpus.

Gate: `bun test packages/compiler/tests/{frontend,edge,qpi,backend,analyzer}` — **1084 pass / 0 fail** on
a clean tree, **1085 / 0** once F217 adds its toolchain test.

## Result

**Twelve findings fixed** — F200, F201, F209, F210, F211, F212, F214, F215, F217, F220, F221 and the new
F222. One refused deliberately (F204). Two published root causes corrected.

**F213 is not among them, and was miscounted as fixed in the first revision of this section.** Part 1
ships and fixes 42 of its 55 rows, but 13 rows still diverge, so the finding is still red. A patch that
moves most of a finding's rows is progress, not a fix, and the count now says so.

| finding | before | after | root cause |
| --- | --- | --- | --- |
| F209 | `proposed` | fixed | `parseQualifiedName` did not consume a leading `::` |
| F210 | `proposed`, cause **not located** | fixed | an alias registered under its bare name answers a qualified lookup with itself; `alignOfNameType` ↔ `alignOfTypeB` then recurse with no depth guard |
| F214 | `proposed` | fixed | the `sizeof` operand was always parsed as an expression, which stops at the first comma |
| F215 | `proposed` | fixed | member-of-a-class-prvalue had three special cases and `SELF` (`id(...)`) matched none |
| F204 | `located` | **refused** | UB in C++; clang answers folded and runtime differently, so there is no semantics to match |
| F217 | `proposed` (2 options, neither right alone) | fixed | nothing resolved names against the block structure — alpha-renaming adds the missing step |
| F212 | `located` | fixed | the scaffold rewrites `CALL(f,…)` to `__qpi_call_self(f,…)`, moving the target out of callee position and taking the context conversion with it |
| F201 | `proposed`, cause **not located** | fixed | `baseContribution` followed the base's typedef exactly one hop |
| F211 | `proposed`, cause **not located** | fixed | nested-type bindings leaked into a struct declared at file scope, so `Outer::inner` resolved to `StateData::Inner` |
| F221 | `verified` — **and wrong** | fixed | the scratch copy is deliberate; the *read-back* was emitted for locals and not for by-value parameters |
| F222 | — | **new** | overload viability compared parameter count for equality, so an overload with defaults was non-viable for every under-supplied call and the first-declared one won by being the seed |

Still red after this pass:

| finding | state | why |
| --- | --- | --- |
| **F213** | 42 of 55 rows fixed, **13 still red** | part 1 ships; part 2 fixes the last 13 and breaks 17 elsewhere, so it does not ship — see below |
| **F203** | unchanged | root cause still open; the published one was wrong and the follow-up theory fixes nothing |
| **F205** | not attempted | its card sequences it after the F213 scope work, which is not done |

### Why part 2 is not a fix, and why "13 fixed, 17 broken" is not a trade to take

The 13 remaining F213 rows are enum-vs-`constexpr` on the *bare* name: the enum loop calls
`constexprInit.delete(key)` on the bare key and evicts a real file-scope constant. Stopping that
eviction fixes those 13 — and turns 17 `LogPayloadWithIdField` rows red, because the resulting rule is
"a `constexpr` always beats a later enum member", which is just the mirror of the original bug rather
than the C++ rule.

Net −4 rows, but the arithmetic is beside the point: both drafts pick a winner by *kind of declaration*.
The actual rule is scope-aware — nearest declaration wins, and an equal-scope collision is **ambiguous
and should be a diagnostic**. Until that is written, part 2 is a different wrong answer, not a fix.

An earlier draft ("first declaration wins") was worse still: it resolved `enum E { A = 4, B, C = 9, D }`
to 66 and 68 — the ASCII values — because a snapshot enum already owned the bare keys and the contract's
own enum could no longer claim them. The unit suite caught that one.

Patches, one per finding, with the measured numbers: `docs/findings/fixes/`.

## Two published root causes were wrong

**F221.** The register said `argAddr` hands a mutable `T&` a throwaway scratch copy. The copy is real and
it is *correct*: a scalar living in a wasm local has no address, so a mutable reference to it must be
passed as one. Dumping the WAT for the repro showed what actually happens:

```wat
(i64.store (local.get $__qinit_tmp20) (local.get $days))          ;; copy in
(call $T9_DateAndTime_addWithoutOverflow ... (local.get $__qinit_tmp20) ...)
                                                                  ;; <-- no read-back
(call $T18_DateAndTime_add ... (local.get $days))                 ;; reads the original
```

The read-back *is* emitted three lines above for `newHour` and `dayCarry` — both body locals. `days` is a
parameter of `add`, and the condition guarding the write-back only looked in `context.localVars`. One
condition, and the two kinds of storage are treated alike.

Worth recording how the wrong cause survived: it was plausible, it named real code, and nobody built it.
Reading the emitted WAT settled it in one step.

**F203.** Unchanged from the round-7 addendum — the code the register blamed is never entered for
`qpi.K12`, and the follow-up theory (pass every reference by address) was built and fixes nothing.

## F222 — found by disproving F221

While reading `qpi_date_time.h` for F221, the eight-argument `add` tail-calls the three-argument
`add(years, months, days)`. That is an overload set where one member has trailing defaults. A probe of
that shape:

```cpp
static void narrow(Box&, sint64 a, sint64 b, sint64 c);
static void narrow(Box&, sint64 a, sint64 b, sint64 c,
                   sint64 d, sint64 e, sint64 f, sint64 g = 0, sint64 h = 0);

narrow(box, 1, 2, 3)             // clang 600   typescript 600
narrow(box, 1, 2, 3, 4, 5, 6)    // clang 615   typescript 600   <-- ran the 3-parameter body
```

`pickHelperOverload` returned -1 for any candidate whose parameter count did not equal the argument
count. With defaults, *no* candidate is ever an exact match for an under-supplied call, so every one
scored -1 and the loop kept its seed — `set[0]`, the first declared. Surplus arguments were dropped
without a diagnostic.

It does **not** cause F221: reverting this patch and re-running `AddMillisecDayCarry` still gives
`1 2024 1 2 0 1 14 752 2` on both backends. Two separate defects reachable from one qpi.h function.

No corpus row exercises this shape, so the corpus could not have found it.

## The harness caught two of my own errors

`probeGen.ts` passed the file's basename as the contract name, so its clang leg reported
`too many errors emitted` for `F211` and `F212` — which I nearly read as "clang refuses it too". Building
those two through `buildContractWithClang` with the real contract name shows clang compiles F211 fine
(18 KB module) and refuses F212 with exactly one error, which is the finding. The probe now takes the
file name separately.

The first draft of F217 renamed *every* nested declaration rather than only ones that hide an outer name.
That broke two things the unit suite caught immediately: a multi-declarator statement parses as a
compound marked `synthetic`, which is not a block, so `uint64 x = 1, y = 3;` put `x` and `y` out of reach
of the next line; and `subExpressions` used `operand` where the AST spells it `argument`, so `i++` kept a
stale name. It also sent one test file into an infinite loop. The narrowed rule — rename when the name
means something outside the block, or shadows an enclosing local — leaves every contract with no
collision byte-identical.

## Corpus, all patches stacked

Full tier — the committed one, 6,618 contracts:

```
6618 contracts · 6471 match · 147 not-match · 0 hang · median 672ms
  0 digest-mismatch   0 trap-divergence   0 both-rejected   0 harness-error
```

Diffed row-by-row against the round-7 baseline (`work/round7-results.jsonl`, 6,617 shared ids):

| rows | transition | what it is |
| --- | --- | --- |
| 48 | `step-mismatch` → `match` | F213 part 1 (42) and **F221** (6 `DateAddMillisecCarryChain`) |
| 4 | `one-side-rejected` → `match` | **F201** — `NsInheritedNamespacedTypedef` |
| 2 | `trap-divergence` → `match` | F200 — the two `sint32` `DivQpi` rows |
| 93 | `match` → `expect-violation` | pinned rows reporting their defect is gone: F212 15, F209 15, F217 12, F214 11, F215 10, F211 8, F220 22 |
| 5 | `step-mismatch` → `one-side-rejected` | F204 turning a wrong answer into a refusal — intended |
| 4 | `match` → `one-side-rejected` | F204's real cost, below |

**Zero** `match` → `step-mismatch`, `digest-mismatch`, `trap-divergence` or `harness-error`, and no new
hang, across 6,617 contracts. No correctness regression anywhere.

### F204 refuses 9 rows, not 5

The register card gives F204 five red rows, so refusing constant out-of-range shifts reads like it
touches five contracts. It touches **nine** of the seventeen `ShiftRhsWiderThanLhs` variants. Five were
the diverging ones. The other four **both backends agreed on** — UB expressions where clang's folded
answer and the wasm answer happened to coincide — and the rule refuses them anyway, because it refuses
by the shape of the expression rather than by whether the two backends got lucky.

That is correct for a rule that declines to pick a semantics, and it is close to double the blast radius
the card implied. It is the one number here a reviewer should see before deciding to land F204.

The 45 genuine mismatches that remain are F203 (32 rows) and F213 part 2 (13), both unfixed and both
mismatching before these patches. The 93 pinned rows fail *because* the defect is gone — the pins exist
to fail that way — and need removing as part of landing any of this.


# The three that were still open — closed, with clang as the oracle

The verification pass left F203 unlocated, F213 red on 13 rows, and F205 untried. This closes all three,
and revisits F204, whose fix was wrong on the campaign's own terms.

**The standard applied throughout: clang is the oracle.** Where the two backends disagree the answer is
whatever clang emits, because that is what the chain runs. A fix is right when it makes the TypeScript
backend produce clang's answer — not when it merely makes the two agree, and not when it refuses the
program instead.

## F203 — located on the third attempt, from the emitted WAT

Two published root causes were wrong. Dumping the wasm settled it in one step: the contract compiles
**two** K12 instantiations.

```wat
(func $T0_QpiContextProcedureCall_K12 ...
  (call $lh_k12 (local.get $data) (i32.const 8) (local.get $digest)))   ;; the two controls
(func $T1_QpiContextProcedureCall_K12 ...
  (call $lh_k12 (local.get $data) (i32.const 1) (local.get $digest)))   ;; the two expressions
```

`sizeof(T)` is 8 for `qpi.K12(input.a)` and **1** for `qpi.K12(input.a + input.b)`, and the argument
scratch is allocated 4 bytes with the value truncated by `i32.wrap_i64` to match. So the expression rows
hash one byte of a truncated copy — which is exactly why the digest was the K12 of no value in the
contract, and why nobody recognised it.

`methodArgTypes` recognised three argument shapes — an addressable lvalue, a construction, a call naming
an aggregate — and returned null for everything else. Every computed expression is "everything else", so
`T` was never bound. An rvalue has a type in C++ just as an lvalue does, and `scalarTypeInfo` already
computes it — it is what the backend trusts to lower the arithmetic itself. Deduction simply never asked.

General: any `template<typename T>` QPI method called with an expression was mis-deducing. K12 is only
where the width is observable in the answer.

### The first cut of this fix was general-looking and still had a hole

The fallback reads `scalarTypeInfo`, so it looks like it covers everything that function can report.
It covers what the *map behind it* lists, and the first cut listed widths 1, 2, 4 and 8. `uint128` is
16, so `qpi.K12(a128 + b128)` went on hashing one byte — the same defect surviving at the one width the
fix forgot, and the corpus could not see it because no archetype hashes a 128-bit expression.

Found by asking what the boundary of "general" actually was rather than asserting it, and pinned by a
new triage repro: `triage/F203-k12-wide/`, which hashes a `uint128` sum through a local and through the
expression and asserts the two agree. Both backends now answer `same = 1`; the TypeScript backend
answered 0 before.


## F213 — decide by scope, not by kind

Part 1 fixed 42 of 55 rows. The rejected part 2 fixed the last 13 and broke 17, because it made a
`constexpr` beat a later enum member outright — precedence by *kind of declaration*, which is the
original bug mirrored.

A bare key is not a declaration; it is how a using-directive reaches a namespaced name, so several
declarations compete for one slot. C++ gives it to the nearest. `bareNameScope` now records which
declaration owns each bare name, both collectors consult it, and the cross-kind deletes follow it so
neither side can evict a nearer declaration. Equal scope keeps last-writer-wins, which is what lets a
contract shadow a qpi.h constant — the case an earlier "first declaration wins" draft broke by letting a
snapshot enum own the bare keys first.

Order-independent, and symmetric between the two kinds. All 55 rows, and `logging` stays 306/306.

## F205 — class scope is searched first

`enum Kind { Helper = 3 }` at file scope beside `PRIVATE_FUNCTION(Helper)` in the contract: name lookup
inside a member function searches class scope before namespace scope, so `Helper` names the member
function and `state.mut().hidden = Helper;` is ill-formed. clang says so; the backend took the enum
constant and stored 3. `hasStateParam` is the class-scope boundary — it marks the contract's own
entries — so a qpi.h body using a constant that shares a name with some contract's entry is unaffected.

## F204 — the oracle rule caught my own fix

The verification pass shipped a patch that **refused** an out-of-range constant shift, arguing that the
expression is undefined behaviour and clang contradicts itself between the folded and runtime spellings.
That was a policy choice dressed as a fix, and it was measurably wrong: clang *compiles* these
contracts, and refusing them made **4 corpus rows that previously agreed with clang stop agreeing**.

The rule was then measured off clang rather than reasoned about. A probe shifting a runtime value by a
constant count outside the operand width, built with wasi-sdk clang:

| expression | clang |
| --- | --- |
| `value << 254` | 0 |
| `value >> 254` | 0 |
| `signedValue >> 254` | 0 |
| `value << -3` | 0 |
| `narrow << 40` (uint32) | 0 |
| `value << 3` (control) | 40 |

Uniform: a constant count outside `[0, width)` yields 0, left and right, signed and unsigned, at every
width. Only the count folds — the value stays a runtime operand — so this is clang's codegen answer, not
its constant evaluator's. The backend now folds to 0 and leaves a runtime count masking.

It reproduces clang's self-inconsistency on purpose: `agreeOutOfRange` reads 0 on both backends. That is
the finding's actual point — a contract tested under `--compiler typescript` must predict the deployed
answer, including where the deployed answer is odd.

## Corpus: every row matches clang

Full tier, all sixteen patches:

```
6618 contracts · 6510 match · 108 not-match · 0 hang · median 250ms
  0 digest-mismatch  0 step-mismatch  0 trap-divergence
  0 one-side-rejected  0 both-rejected  0 harness-error
```

The 108 are `expect-violation` and nothing else — pinned rows reporting that their defect is gone, which
is what those pins exist to do. They are the ten pinned archetypes for F220 (22), F212 (15), F205 (15),
F209 (15), F217 (12), F214 (11), F215 (10) and F211 (8), and they need unpinning as part of landing any
of this.

Against the round-7 baseline over the same shared ids: **98 rows step-mismatch → match**, 4
one-side-rejected → match, 2 trap-divergence → match, and **zero rows move from match to any real
mismatch**.

All sixteen compiler findings are closed. Unit suite 1085 pass / 0 fail.


# Auditing the three enumerative fixes — every one was a fix for one call path

F203, F215 and F221 are the three fixes in this campaign that add a case to an enumeration rather than
change a rule. The other thirteen change a rule. That distinction turned out to predict which fixes were
incomplete: **all three of the enumerative ones were.**

The audit method was one probe per site, each row hashing or computing a value two ways — through a form
known to work, and through the form under test — with clang as the arbiter. A row where both backends
agree is not a bug even when the two spellings differ, which is worth stating because one row looked
like a finding and was not.

## Site 1 — template argument deduction (F203)

| row | clang | typescript | |
| --- | --- | --- | --- |
| qualified namespace constant | 1 | 1 | fine |
| `qpi.K12(qpi.tick())` | 0 | 0 | **not a bug** — `tick()` is narrower than the local, and both backends agree it is |
| helper returning **more than 8 bytes** | 1 | 0 | **hole** |
| unary negation | 1 | 1 | fine |
| control, `a + 1` | 1 | 1 | the F203 fix holds |

`scalarTypeInfo`'s call branch reads a helper's declared return type and then discards it when it is
wider than 8 bytes. So `qpi.K12(widen(x))` with `uint128 widen(uint64)` deduced nothing and fell back to
`sizeof(T) == 1` — F203's own defect, surviving behind F203's fix.

Fixed by consulting the callee's declared return type directly, which is authoritative and has no width
ceiling.

## Site 2 — member access on a class prvalue (F215)

A member read off a **ternary** is still refused:

    ((input.a > 0) ? locals.left : locals.right).u64._0
    // clang 7; TypeScript: error: unsupported member read [paren.u64._0]

Not fixed. It is a refusal rather than a wrong answer, which is the right failure mode, but it refuses
code clang accepts. Recorded, not closed.

## Site 3 — write-back through a mutable reference (F221)

| row | clang | typescript | |
| --- | --- | --- | --- |
| member off a helper-returned aggregate | 5 | 5 | fine |
| **write-back into a by-value parameter** | 15 | 5 | **hole** |
| write-back into an addressable local | 6 | 6 | fine |

This is F221 again, in a call path the fix never touched. `this-call.ts` handles container and `qpi`
methods, which is where `DateAndTime::add` lives and therefore the only path the repro exercised. A
contract's own `static void bump(uint64& slot, uint64 by)` goes through `helperCallOps` → `argAddr`,
which has **no write-back at all** — every write through a mutable scalar reference was dropped.

The addressable-local row passing is the giveaway: `locals.counter` is a member of the locals struct, so
it has a real address and no copy is made. Only storage with no address loses the write, and a helper's
own parameters are exactly that.

Fixed, and the rule now lives once in `backend/wasm/memory/reference-arguments.ts`, which both call
paths consult. Duplicating it is what let the two drift in the first place.

# F223 — assigning a helper's aggregate return stores a default-constructed value

Found while chasing the site-1 hole; it is a separate defect and a serious one. The wasm computes the
call correctly, into scratch, and then ignores the result:

```wat
(call $h_widen (local.get $__qinit_tmp9) (i64.load (local.get $__qinit_in)))   ;; result -> tmp9
(call $T2_uint128_t_uint128_t (local.get $__qinit_tmp8) (i64.const 0))         ;; construct uint128_t(0)
(call $copyMem (i32.add (local.get $__qinit_locals) (i32.const 16))
               (local.get $__qinit_tmp8) (i32.const 16))                       ;; copy THAT, not tmp9
```

`emitLibraryCall` materialises an aggregate return into scratch and then returns `(i64.const 0)` in
value context, throwing the address away. The assignment sees a scalar zero and runs the type's
converting constructor on it.

Measured: `locals.returned = widen(5)` reads **0** on the TypeScript backend and 5 on clang. Pinned at
`triage/F223-aggregate-return-assignment/`, with an out-parameter control that both backends get right,
so the finding is about the return path and not about aggregates generally.

Not fixed. `x = f()` where `f` returns an aggregate is ordinary code, so this deserves its own
root-cause pass rather than being folded into the audit.

# The fail-closed guard — built, and it should not ship as written

An unbound template type parameter is now a build error rather than `sizeof(T) == 1`. It fires
correctly on genuinely undeducible arguments.

It also rejects `qpi.K12(qpi.tick())`, whose callee is a member access that `scalarTypeInfo` does not
type. **clang compiles that**, and before the guard both backends agreed on it.

That is the F204 mistake wearing different clothes: converting a silently wrong answer into a wrongly
rejected program is still not matching the oracle. The guard is right in principle — the recognised
shapes should be a fast path, not the correctness boundary — but it must not land until deduction
covers the shapes clang can obviously type. Recorded as built and measured, and deliberately not
recommended for landing in this state.
