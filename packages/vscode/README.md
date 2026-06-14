# Qubic QPI — VS Code extension

CLion-grade IntelliSense and live protocol diagnostics for Qubic dynamic contracts (QPI), powered by [clangd](https://clangd.llvm.org/) and the [`qinit`](https://github.com/hackerby888/qinit) toolchain.

## Features

- **Full C++ IntelliSense** — completion, hover, go-to-definition into `qpi.h`, signature help — with **no manual `#include "qpi.h"`**. The extension generates a per-contract clangd compile database so the editor sees exactly what `qinit build` compiles (no drift).
- **Live QPI rule diagnostics (Tier-A)** — instant, comment/string-aware checks for the `qpi.h` restrictions (forbidden `"` `'` `#` `/` `%` `[` `]` `__`, `float`/`double`/`union`/`const_cast`, global `typedef`/`using`, …).
- **Authoritative diagnostics (Tier-B)** — runs `contractverify` on save and surfaces violations inline.
- **IDL hover** — hover a registered function/procedure to see its on-chain index and input/output codec.
- **CodeLens** — build / deploy / gen-client on the contract; call on each registered function.
- **Quick-fixes** — e.g. `T[N]` → `Array<T, N>`.
- **Command palette** — build, deploy, call, gen, test, up, doctor, new.

## Requirements

- The [`qinit`](https://github.com/hackerby888/qinit) CLI on your `PATH`.
- Run `qinit up` once to sync the core headers + the wasm compiler the extension needs.
- The clangd extension (installed automatically as a dependency).

In a qinit project the extension disables the Microsoft C/C++ extension's IntelliSense (it doesn't understand `qpi.h`, so it would show false errors) — clangd becomes the sole C++ provider.

## Install

- From the CLI: **`qinit ext install`**
- Or search the Marketplace for **Qubic QPI**.
