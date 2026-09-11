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

## Reducing a finding

`triage-probe.ts` runs one hand-reduced repro through both backends and prints the two final states
side by side, working from a bare directory — a `.h`, a `script.json`, nothing else — rather than from
the generated corpus:

    QINIT_CORE=/path/to/core-lite \
    T_BASE=$PWD/corpus/solidity-port/triage/F203-k12-expression T_NAME=K12Struct \
    bun run scripts/solidity-port/triage-probe.ts

| variable | meaning |
| --- | --- |
| `T_BASE` | Absolute path to the triage directory. **Must be absolute** — the clang wrapper compiles from its own output directory, so a relative path resolves against the wrong cwd and returns `fatal error: '...' file not found`, which reads exactly like clang rejecting the contract. |
| `T_NAME` | The contract name, i.e. the struct inheriting `ContractBase`. |
| `T_FILE` | The header's basename when it differs from `T_NAME`. Passing the file name as the contract name makes clang report undeclared identifiers, which also reads like a rejection. |

State prints as little-endian u64 words rather than hex, so a wrong digest is readable and a
`StateData`'s fields line up one per column.

## The third oracle

Two backends sharing one build gate, one `qpi.h` and one `QubicSimulator` can only ever be shown to
agree with each other. `wamr-probe.ts` and `wamr-sweep.ts` run each backend's *artifact* on the
runtime core actually uses, asking a different question of each backend separately: does this artifact
behave the same on the qinit simulator and on core's real runtime? A contract where both backends
agree with each other and both differ from WAMR is a finding no two-backend round can produce.

It drives core's `WasmContracts.CrossHostStateEquivalence` gtest, which takes `QINIT_WASM`,
`QINIT_SCRIPT` and `QINIT_EXPECTED_SLOT` and prints one `CROSSHOST_OP=<n>:ok:<hex>` or
`CROSSHOST_OP=<n>:trap` per op, then `CROSSHOST_STATE=<hex>`. Build it with:

    cmake -S . -B build-wasm -G Ninja -DBUILD_TESTS=ON -DLITE_WASM_SC=ON \
          -DTESTNET=ON -DTESTNET_LITE_RAM=ON -DBUILD_BINARY=OFF -DUSE_SANITIZER=OFF
    cmake --build build-wasm --target qubic_wasm_tests

    bun run scripts/solidity-port/wamr-probe.ts <header> <ContractName> <slot> <op>...
    bun run scripts/solidity-port/wamr-sweep.ts [--family <name>] [--limit <n>] [--backend clang|typescript|both]
