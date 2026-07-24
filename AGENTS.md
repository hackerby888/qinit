# Repository Guidelines

## Project Structure & Module Organization

Qinit is a Bun/TypeScript ESM workspace. Package code lives under `packages/`: `cli` provides the Ink command interface, `core` handles Qubic primitives and RPC, `build` generates contract projects, `compile` implements the TypeScript-to-Wasm compiler, `engine` simulates contracts, `proto` owns wire/ABI codecs, and `vscode` contains the extension. Keep package tests in `packages/<name>/tests/`; shared helpers belong in `test-utils/`. Contract fixtures live in `fixtures/`, automation in `scripts/`, and design notes in `docs/`. Update generated sources only through their owning generator.

## Build, Test, and Development Commands

Use Bun 1.3.14, matching CI.

```sh
bun install                 # install all workspace dependencies
bun run dev help            # run the CLI directly from source
bun run typecheck           # strict TypeScript check without emitting files
bun test                    # run the Bun test suite
bun run build:bin           # compile the standalone CLI to dist/qinit
./dist/qinit smoke           # validate the compiled binary
bun run build:all           # build the cross-platform release matrix
```

Live-core checks need a sibling checkout: `QINIT_CORE=/path/to/core-lite bun run test:sc:light`. Prefer a focused test while iterating: `bun test packages/core/tests/crypto/qubic.test.ts`.

## Coding Style & Naming Conventions

Follow surrounding TypeScript: two-space indentation, double quotes, semicolons, trailing commas, and readable multiline expressions. Use `camelCase` for functions and variables, `PascalCase` for types and components, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames. No general formatter is configured, so keep diffs narrow and run typechecking. Preserve public APIs and behavior unless the change explicitly requires otherwise; comments should be brief and useful.

Read CODING_RULES.md for more details.

## Testing Guidelines

Tests use `bun:test` and descriptive `*.test.ts` names grouped by package and domain. Add a regression test beside the affected package and run both the focused file and relevant broader suite. There is no numeric coverage threshold. Run core binaries from a temporary directory because they create runtime data relative to their working directory.

## Commit & Pull Request Guidelines

Use short imperative subjects such as `Fix nested constant resolution` or `Support oracle subscriptions`; do not mention AI/LLM tools. Keep each commit scoped to one concern. PRs should explain behavior and compatibility impact, list validation commands, link applicable issues, and include screenshots only for visible CLI or VS Code changes. Keep relevant CI checks green.

## Security & Configuration

Never commit or log real signing seeds. Keep machine-specific core paths in `QINIT_CORE`, not source files, and do not commit generated runtime data, logs, or local environment files.
