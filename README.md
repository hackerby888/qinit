# Qinit

Anchor-like framework for **Qubic dynamic contracts** — scaffold → build → deploy → test → typed
client, shipped as a single standalone binary. Pairs with
`qubic-core-lite/src/extensions/DYNAMIC_CONTRACTS.md`.

See [PLAN.md](./PLAN.md) for the full design and milestones.

## Status — M0 (bin skeleton)

Bun workspaces + `--compile` standalone-binary config, an Ink CLI, `doctor`, and the crypto smoke
test that validates the binary path before any real feature code.

## Prereqs

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- `clang-18` (for the future `.so` build pipeline) — already required by qubic-core-lite.

## Run

```bash
bun install

# dev (no compile)
bun run dev help
bun run dev doctor
bun run dev smoke

# standalone binary — the shipping artifact
bun run build:bin           # -> dist/qinit
./dist/qinit smoke          # MUST pass from the compiled binary (validates bundled wasm crypto)
./dist/qinit doctor

# all targets
bun run build:all
```

`smoke` derives a Qubic identity (exercising K12 + FourQ from `@qubic-lib/qubic-ts-library`'s wasm)
**inside the compiled binary** — the M0 acceptance gate for the standalone-bin approach.

## Config

- `QINIT_CORE` — path to the `qubic-core-lite` checkout (default `/home/kali/Projects/qubic-core-lite`).

## Layout

```
packages/cli    Ink TUI + command dispatch (the --compile entry)
packages/core   wraps @qubic-lib/qubic-ts-library (identity, K12, sign, tx, connector)
scripts         cross-target build matrix
```
