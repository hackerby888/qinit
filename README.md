# Qinit

Qinit is a Bun/TypeScript toolkit for Qubic Smart Contract: scaffold, compile,
deploy, test, inspect, and generate typed clients from one standalone CLI.

[`docs/`](./docs/README.md) holds the deep dives: the
[CLI guide](./docs/cli-guide.md), the
[compiler walkthrough](./docs/compiler-walkthrough.md) for the
TypeScript-to-Wasm pipeline, and
[browser packaging](./docs/browser-packaging.md).

## Install

Prebuilt binary (no Bun needed):

```bash
curl -fsSL https://raw.githubusercontent.com/hackerby888/qinit/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hackerby888/qinit/main/install.ps1 | iex
```

The installer puts `qinit` in `~/.local/bin` on Linux/macOS and
`%LOCALAPPDATA%\qinit\bin` on Windows (override with `QINIT_BIN`). It then runs
`qinit setup` to cache the core headers, node binary, WASI SDK, and contract
verifier. Unavailable platform assets are reported without removing the CLI.

Release assets:

| OS      | Architecture  | Asset                   |
| ------- | ------------- | ----------------------- |
| Linux   | x64           | `qinit-linux-x64`       |
| Linux   | arm64         | `qinit-linux-arm64`     |
| macOS   | Apple Silicon | `qinit-darwin-arm64`    |
| macOS   | Intel         | `qinit-darwin-x64`      |
| Windows | x64           | `qinit-windows-x64.exe` |

After a manual download, run `qinit setup` and `qinit doctor`.

## Develop

Use Bun 1.3.14, matching CI:

```bash
bun install
bun run dev help
bun run typecheck
bun test
```

Build and check the standalone CLI:

```bash
bun run build:bin
./dist/qinit smoke
```

Live core-lite checks need a checkout supplied through `QINIT_CORE`:

```bash
QINIT_CORE=/path/to/core-lite bun run test:sc:light
```

Run node binaries from a temporary working directory because they create
runtime data relative to the current directory.

## Integrate with Qubic Core

`qinit integrate` copies one Qinit contract into the latest `qubic/core` main
branch and wires its optional GTest into the Visual Studio projects:

```bash
qinit integrate contracts/Counter.h
```

For a new integration, Qinit clones Core into `../Counter-core`, creates
`qinit/counter`, and prompts for the asset name, construction epoch, and
destruction epoch (default `10000`). Non-interactive use supplies the required
metadata explicitly:

```bash
qinit integrate --contract contracts/Counter.h --contract-name Counter \
  --out ../Counter-core --asset COUNTER --construction-epoch 250
```
