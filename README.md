# Qinit

Qinit is a Bun/TypeScript toolkit for Qubic dynamic contracts: scaffold, compile,
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

| OS | Architecture | Asset |
|---|---|---|
| Linux | x64 | `qinit-linux-x64` |
| Linux | arm64 | `qinit-linux-arm64` |
| macOS | Apple Silicon | `qinit-darwin-arm64` |
| macOS | Intel | `qinit-darwin-x64` |
| Windows | x64 | `qinit-windows-x64.exe` |

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

## Prepare an upstream Core checkout

`qinit upstream` copies one Qinit contract into the latest `qubic/core` main
branch and wires its optional GTest into the Visual Studio projects:

```bash
qinit upstream contracts/Counter.h
```

For a new integration, Qinit clones Core into `../Counter-core`, creates
`qinit/counter`, and prompts for the asset name, construction epoch, and
destruction epoch (default `10000`). Non-interactive use supplies the required
metadata explicitly:

```bash
qinit upstream --contract contracts/Counter.h --contract-name Counter \
  --out ../Counter-core --asset COUNTER --construction-epoch 250
```

Re-running the command against a clean existing checkout updates the contract
source and test while preserving its registered index, asset, and epochs.
Referenced custom callees must already be registered in that Core checkout at
lower indices; Qinit does not recursively add them. Core currently builds these
projects with Visual Studio on Windows, and the command prints the next NuGet,
MSBuild, and test commands.

## Workspace

| Path | Responsibility |
|---|---|
| `packages/cli` | Ink command interface and standalone binary entry |
| `packages/core` | Qubic primitives, signing, RPC, tool downloads, and source metadata |
| `packages/build` | Contract builds, dependency graphs, slot planning, IDL, and project generation |
| `packages/compiler` | TypeScript-to-Wasm compiler and browser entry |
| `packages/engine` | In-process contract simulation and protocol adapters |
| `packages/proto` | Dynamic-contract wire, ABI, and IDL codecs |
| `packages/vscode` | QPI language support extension |
| `fixtures` | Shared contract fixtures |
| `scripts` | CI, release, live-node, and compatibility automation |
| `test-utils` | Shared test helpers |

Workspace packages are private while their distribution contracts are being
stabilized. Qinit releases the standalone CLI and contract-verifier artifacts;
there is currently no npm package release workflow.

## Cross-repository development

`config/repositories.json` owns the first-party repositories and branches;
`config/toolchains.json` owns external repositories and tool versions. After
editing either file, run `bun run sources:sync`. CI runs
`bun run sources:check` to reject stale generated values.
After changing the Bun version, also run `bun install` to regenerate `bun.lock`.

An empty core-lite `pinnedCommit` follows the latest `developmentRef`; a full
commit SHA selects that exact revision. Each CI run resolves the selected ref
once and uses the resulting commit for every job.

Manual CI runs accept repository and ref overrides, so a new organization or
branch can be tested before changing the descriptor. The installers also accept
`QINIT_REPOSITORY=owner/repository` when testing a moved Qinit release source.
