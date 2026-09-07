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
