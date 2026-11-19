# Third-party notices

Qinit's own source code is released under the MIT License. See [LICENSE](LICENSE).

Qinit also contains, or downloads and uses, material from other projects. That material stays under its own
licence, not under MIT.

## Qubic Core

What comes from Core:

- the QPI snapshot in `packages/compiler/src/generated/qpi-snapshot.ts`, generated from Core's headers;
- the contract and QPI headers in the `core-headers` release archive that `qinit setup` installs, and the copy
  of them inside the editor extension;
- the node binary that `qinit setup` downloads, built from [core-lite](https://github.com/hackerby888/core-lite).

Licence: the **Anti-Military License**. It allows free use, with a ban on military use. Read it at
<https://github.com/qubic/core/blob/main/LICENSE.md>. A copy travels in every headers archive, as
`LICENSE.md`.

One Core file, `src/platform/uint128.h`, is under the MIT License, copyright Jason Lee. Its notice travels in
the same archive as `LICENSE-MIT.md`.

## WASI SDK

`qinit setup` downloads the [WASI SDK](https://github.com/WebAssembly/wasi-sdk) to compile contracts, and the
editor extension carries the libc++ headers a contract's includes reach.

Licence: Apache License 2.0 with LLVM exceptions.
