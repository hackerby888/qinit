# Solidity-port differential corpus

Generated. Do not edit by hand — edit the archetype in `scripts/solidity-port/archetypes/` and
regenerate. `bun run scripts/solidity-port/generate.ts --check` enforces that in CI.

Tier `full` · 68 archetypes · 605 contracts · generator version 1.

| family | contracts |
| --- | ---: |
| assets | 12 |
| containers | 48 |
| controlflow | 35 |
| integers | 345 |
| layout | 81 |
| lifecycle | 5 |
| logging | 6 |
| namespaces | 60 |
| vulnerabilities | 13 |

## What this is

Each contract is a Qubic QPI port of a tricky Solidity pattern, taken from
`ethereum/solidity`'s `test/libsolidity/semanticTests`, `crytic/not-so-smart-contracts` and
OpenZeppelin. Every file's header comment names its Solidity origin, what it stresses in the
compiler, and how the port differs from the original.

The corpus exists to be compiled by **both** Qinit backends — the TypeScript compiler and clang —
and executed on a byte-identical call script, so their final-state K12 digests can be compared.

```sh
export QINIT_CORE=/path/to/core-lite
export WASM_CLANG=/path/to/wasi-sdk/bin/clang++ WASI_SYSROOT=/path/to/wasi-sdk/share/wasi-sysroot
bun run scripts/solidity-port/run-differential.ts --tier full --workers 3
```

## What it is not

Only 284 of 605 contracts are faithful ports; the rest are marked `shape-only` in
`manifest.jsonl`. QPI has no revert, no `uint256`, no unbounded mapping and no reentrancy, so a
Solidity test whose point was atomicity or 256-bit wraparound becomes a *different* test after
porting. The corpus is a source of adversarial **shapes**, not evidence about Solidity semantics.

Nor is it a set of independent trials: the contracts are variants of a much smaller number of
archetypes, so the effective sample size is closer to the archetype count than the contract count.
The variants earn their place as an axis bisector during triage — when a mismatch appears, the
sibling variants that differ in exactly one axis name the trigger.
