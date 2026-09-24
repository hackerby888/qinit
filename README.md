# Qinit

Build, test and deploy Qubic smart contracts. Qinit scaffolds a project, compiles it, runs it on a local chain, tests it,
inspects its state, and generates typed clients, all from one standalone CLI.

## Platforms

| OS      | Architecture         |
| ------- | -------------------- |
| Linux   | x64, arm64           |
| macOS   | Apple Silicon, Intel |
| Windows | x64                  |

## Install

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/hackerby888/qinit/main/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/hackerby888/qinit/main/install.ps1 | iex
```

The installer puts `qinit` in `~/.local/bin` on Linux and macOS, or `%LOCALAPPDATA%\qinit\bin` on Windows. It then runs
`qinit setup`, which fetches the local node, the Qubic Core headers and the Wasm compiler. `qinit doctor` checks the setup.

## Quick start

```bash
qinit new Counter                  # contracts/Counter.h, tests/Counter.test.ts, tests/Counter.test.cpp
cd Counter

qinit deploy                       # deploy Counter to it
qinit call --proc Counter Inc      # send a transaction to the Inc procedure
qinit call --fn Counter Get        # read the counter back: 1

qinit test                         # run tests/Counter.test.ts on a fresh local chain
qinit gtest                        # run tests/Counter.test.cpp, Core's C++ test style
qinit node run                     # start a local Qubic chain
qinit node stop
```

`qinit <command> --help` lists every option, and `qinit call` with no arguments picks the contract and entry point
interactively.
