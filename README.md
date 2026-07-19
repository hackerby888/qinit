# Qinit

Framework for **Qubic dynamic contracts** — scaffold → build → deploy → test → typed
client, shipped as a single standalone binary. Pairs with
`qubic-core-lite/src/extensions/DYNAMIC_CONTRACTS.md`.

See the [compiler walkthrough](./docs/QINIT_COMPILER_WALKTHROUGH.md) for the current Wasm pipeline.

## Install

Prebuilt binary (no Bun needed):

```bash
curl -fsSL https://raw.githubusercontent.com/hackerby888/qinit/main/install.sh | sh
```

Installs `qinit` to `~/.local/bin` (override with `QINIT_BIN`). Or download from
[Releases](https://github.com/hackerby888/qinit/releases/latest):

| OS | arch | asset |
|----|------|-------|
| Linux | x64 | `qinit-linux-x64` |
| Linux | arm64 | `qinit-linux-arm64` |
| macOS | Apple Silicon | `qinit-darwin-arm64` |
| macOS | Intel | `qinit-darwin-x64` |
| Windows | x64 | `qinit-windows-x64.exe` |

Then `qinit doctor`. (Building from source is below.)

## Status — M0 (bin skeleton)

Bun workspaces + `--compile` standalone-binary config, an Ink CLI, `doctor`, and the crypto smoke
test that validates the binary path before any real feature code.

## Prereqs

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- wasi-sdk for the Clang-to-Wasm backend (`qinit node run` fetches and caches it automatically).

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

- `QINIT_CORE` — path to a core-lite checkout. Required by tests and tools that consume live core source:

  ```bash
  export QINIT_CORE=/path/to/core-lite
  ```

## Layout

```
packages/cli    Ink TUI + command dispatch (the --compile entry)
packages/core   wraps @qubic-lib/qubic-ts-library (identity, K12, sign, tx, connector)
scripts         cross-target build matrix
```
