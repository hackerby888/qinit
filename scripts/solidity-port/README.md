# Solidity-port differential sweep

Each contract is a Qubic QPI port of a tricky Solidity pattern, taken from `ethereum/solidity`'s
`test/libsolidity/semanticTests`, `crytic/not-so-smart-contracts` and OpenZeppelin. The sweep compiles
every one with both backends — the TypeScript compiler and clang→wasm32-wasi — runs the same call
script through each, and compares state digests step by step. clang is the oracle: where the two
disagree, clang's answer is the one the chain runs.

## What is checked in, and what is not

This directory is the machine: the generator, the runner, the comparator, and the archetypes every
contract is expanded from. `corpus/solidity-port/triage/` holds hand-reduced repros, one directory per
finding — a single `.h`, a `script.json`, usually a `NOTES.md` recording what each backend answered.
Those are written by hand and are committed.

The corpus itself is **generated and not committed** — `corpus/solidity-port/variants/`, `scripts/`,
`manifest.jsonl` and its `README.md` are all build output. Edit an archetype, never a generated
variant.

## Running a sweep

    bun run corpus:generate
    bun run corpus:sweep -- --tier smoke --workers 3 --no-resume --exit-zero --out work/sweep.jsonl
    bun run corpus:gate -- work/sweep.jsonl

`--tier smoke` is one contract per archetype; `full` is the whole cross product. Two flags matter:
`--no-resume`, because the runner otherwise resumes from the out file and silently skips rows a stale
file already carries, and `--exit-zero`, because open findings mean a clean run still has non-matching
rows — `corpus:gate` owns the pass/fail decision, not the runner.

Both backends need a core-lite checkout (`QINIT_CORE`) and a WASI SDK (`WASM_CLANG`, `WASI_SYSROOT`).
Without them the sweep skips rather than fails, so CI sets `QINIT_REQUIRE_CONTAINER_TOOLCHAINS=1`.

## The gate

`corpus:gate` reads `known-divergences.ts`, the single list of archetypes that still disagree with
clang, and fails in both directions: a divergence that is not listed is a regression, and — under
`--strict` — a listed archetype that has stopped diverging is a stale entry to delete. `--strict`
belongs only on a run that exercises every variant, because a smoke tier can leave a listed archetype
agreeing on the one variant it happens to run.

`both-rejected` counts as agreement rather than divergence: neither backend built the contract, so the
two agree it is invalid. That is what a fix produces when clang refuses something the TypeScript
backend used to compile.

**The result depends on the core version.** clang compiles against core's real `qpi.h`, so which
contracts diverge moves when core-lite does. CI resolves the ref in `config/repositories.json`; a local
run against an older checkout will not reproduce it exactly.
