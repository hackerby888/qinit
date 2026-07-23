# Qubic QPI

Standalone VS Code language support for Qubic smart contracts.

## Features

- C++ completion, hover, signature help, and navigation through clangd
- Live compiler, QPI rule, and IDL diagnostics
- IDL hover for registered functions and procedures
- Quick fixes for supported QPI violations
- IntelliSense for `contract_testing.h` test files

The extension bundles the Qinit compiler frontend and ships its pinned QPI and C++ headers. Qinit,
core-lite, a node, and the WASI compiler are not required.

## Install

Install **Qubic QPI** from the VS Code Marketplace or install a release VSIX:

```sh
code --install-extension qpi-vscode.vsix
```

The clangd extension is installed as a dependency. It may offer to download clangd once if the
language server is not already available.

## Usage

Open a folder containing a QPI contract header. A contract is recognized by a `struct` or `class`
that inherits from `ContractBase`; unrelated C++ headers are ignored.

For test files, the extension finds the contract from:

1. An optional `qinit.json` contract path
2. `INIT_CONTRACT(Type)` or `ContractTestingType`
3. The only QPI contract in the folder

It does not guess when multiple contracts remain possible.

The extension creates `.clangd` when the folder does not already own one. Existing `.clangd` and
explicit Microsoft C/C++ settings are preserved.

## Scope

Build, verification, deployment, calls, and node operations stay in the Qinit CLI:

```sh
qinit verify
qinit build
qinit deploy
```

The extension does not launch Qinit or connect to a node.
