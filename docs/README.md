# Qinit docs

Deep dives, one file per subject. Each doc opens with a **Scope / Read when / Related** block — check
that before reading further in. The operational rules live outside this folder: `AGENTS.md`
(contribution conventions), `CODING_RULES.md` (style), `CLAUDE.md` (commands and architecture summary),
`README.md` (install and workspace layout).

Sections are numbered, so jump with `grep -n '^## ' docs/<file>.md` rather than reading a whole guide.

| Doc | Covers | Read it when | Does not cover |
|---|---|---|---|
| [cli-guide.md](./cli-guide.md) | `packages/cli` end to end: routing, arguments, config, contracts/IDL, deploy, calls, state and trace decoding, explorer, node lifecycle, tests, RPC surface, sharp edges | Changing a command, an option, deployment, decoding, or node startup | Compiler internals; anything inside `packages/compiler` |
| [compiler-walkthrough.md](./compiler-walkthrough.md) | `packages/compiler`, the `typescript` backend: preprocess → lex → parse → analyze → layout → WAT → Wasm, 25 numbered stages | Changing code generation, memory layout, the QPI snapshot, or runtime dispatch | The `clang` backend (`packages/build`); how the CLI drives a build |
| [browser-packaging.md](./browser-packaging.md) | `@qinit/compiler/browser`: what the bundle embeds, snapshot ownership, local build, verification | Changing the browser entry or regenerating the QPI snapshot | Compiler internals; CLI behavior |

## Where to look

| Question | Go to |
|---|---|
| How does argv become typed options? Where do I register a command? | cli-guide §2–3 |
| Where does `qinit.json`, the user config dir, or the cache live? | cli-guide §4 |
| How is a JSON output, a plain stream, or an exit code decided? | cli-guide §5 |
| How does the CLI find a contract, its slot, and its IDL? | cli-guide §6 |
| What does `build` / `gen` / `verify` / `dev` actually run? | cli-guide §7 |
| What happens during a deploy, and how do the two node backends differ? | cli-guide §8 |
| How are functions and procedures called, and what does `--trace` do? | cli-guide §9 |
| How is contract state decoded from raw bytes? | cli-guide §10 |
| How does the live trace inspector work? The chain explorer? | cli-guide §11, §11.1 |
| How does the explorer name a call and decode its input bytes? | cli-guide §11.2 |
| How is a node started, tracked, and stopped? Where does the simulator run? | cli-guide §12 |
| What are system contracts, and what do `setup` / `clean` / `doctor` own? | cli-guide §13 |
| Why are `test` and `gtest` different systems? | cli-guide §14 |
| Which RPC method hits which endpoint? | cli-guide §15 |
| Which file implements command X? | cli-guide §16 |
| Which tests should I run for this change? | cli-guide §17 |
| I am adding a command / option, or changing deploy, decoding, or node startup | cli-guide §18 |
| Is this behavior a bug or a known wart? | cli-guide §19 (sharp edges) |
| What differs in the compiled binary versus `bun run dev`? | cli-guide §20 |
| Which compiler stage owns this? | compiler-walkthrough §1–25 |
| Why does the user-boundary struct exist? Why is every layer needed? | compiler-walkthrough §5, "Why every layer is needed" |
| How do I regenerate or verify the QPI snapshot? | browser-packaging, "Snapshot ownership" |

## Conventions

- Filenames are kebab-case, like the rest of the repo (`AGENTS.md` § Coding Style).
- `cli-guide.md` states the commit it was verified against. Treat a mismatch with `git log` as a
  reason to re-check a claim, not as a reason to trust the doc over the source.
- Generated files are never documented as hand-editable; each names its generator instead.
