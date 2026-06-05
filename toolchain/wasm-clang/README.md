# wasm-clang — multi-target clang+lld as WebAssembly (toolchain #7)

A WebAssembly build of clang + lld (the LLVM `llvm` multitool) that runs under any WASI runtime
(wasmtime, bun, node) and **cross-emits native objects** for every Qubic node platform — so a contract
dev needs **zero native toolchain** (no system clang/cmake/nasm), just the `qinit` binary + this wasm.

## Status: BUILT + PROVEN (2026-06-05)

`build/bin/llvm` = ~90 MB WebAssembly module (clang, clang++, ld.lld, ld64.lld, wasm-ld, llvm-ar/nm/…
all dispatched by argv[0]). Under wasmtime:
- `clang --print-targets` → **aarch64, arm64, x86, x86-64, wasm32/64**
- cross-emit verified:
  - `--target=x86_64-unknown-linux-gnu`  → ELF 64-bit x86-64
  - `--target=aarch64-unknown-linux-gnu` → ELF 64-bit ARM aarch64
  - `--target=arm64-apple-macosx`        → Mach-O 64-bit arm64

Pairs with the **no-sysroot contract compile** (see ../../docs/WASM_TOOLCHAIN.md): the contract `.so`
is freestanding (`-fno-exceptions -DLITEDYN_CONTRACT_TU`), referencing only ~7 cross-ABI-standard symbols
the node already provides → no per-platform sysroot, just clang's bundled headers.

## How it's built (`build-wasm-clang.sh`)

Recipe = **YoWASP/clang `build.sh`** (their proven wasi config) + our two extra backends:
- source: **YoWASP `llvmorg-21.1.4+wasm`** branch (carries the wasi posix-stub patch set — Program/
  Process/Signals/sockets/Path/Memory/Watchdog/Unix.h/CrashRecoveryContext/InitLLVM). `yowasp-build.sh.ref`
  is their script (the per-tool ON/OFF list is extracted from it at build time).
- host: `wasi-sdk-29` (NOT 33 — 33 declares `getrusage`, breaking config-ix's `HAVE_GETRUSAGE` assumption).
- toolchain file: `--target=wasm32-wasip1 -mcpu=lime1 -D_WASI_EMULATED_MMAN -flto`, link `-lwasi-emulated-mman
  --max-memory=4GiB -z stack-size=8MiB --stack-first --strip-all`.
- `CMAKE_BUILD_TYPE=MinSizeRel` + assertions (Release/Debug clang.wasm fails wasm validation — YoWASP note).
- native tblgen built in-tree (matches the 21.1.4 source).
- the **only** change vs YoWASP: `LLVM_TARGETS_TO_BUILD="X86;AArch64;WebAssembly"` (they ship WebAssembly-only).
- target `llvm-driver` (busybox multitool). ~21 min LTO link; ~50 GB build tree, 22-core box.

```sh
# deps: cmake, ninja, a host clang; downloads wasi-sdk-29 + clones YoWASP llvm 21.1.4+wasm
bash build-wasm-clang.sh        # -> $HOME/wasm-toolchain/build/bin/llvm
```

## How to run it

```sh
wasmtime --dir / build/bin/llvm clang -c --target=x86_64-unknown-linux-gnu -ffreestanding -O2 t.c -o t.o
wasmtime --dir / build/bin/llvm ld.lld -shared t.o -o t.so
```
Or under bun via a jco-transpiled component / `@yowasp/clang`-style runtime (raw `node:wasi` OOMs on the
90 MB module — wasmtime or a memory-growing runtime needed).

## TODO (productionize)

1. Strip/compress the artifact; publish to a GitHub release (built once per LLVM version on the dev box —
   free CI runners lack the ~50 GB disk).
2. `packages/toolchain` in qinit: fetch+cache the wasm + run via a WASI runner; `recipe.ts` selects
   `compileWasm()` when present (drop-in for the native `compile()`).
3. Bundle clang's freestanding headers + per-OS ~7-symbol `.tbd`/crt stub (no full sysroot).
