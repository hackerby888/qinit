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
