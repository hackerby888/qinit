# Plan: in-process WASM toolchain (#7) — zero native-dep contract compile

## Goal
Remove the last host dependency for the **contract-dev** journey. Today `qinit build` shells
out to system `clang++-18` to turn a contract `.h` into a native x86-64 `.so`. #7 bundles a
**WebAssembly build of clang + lld** that Bun runs in-process, so a dev needs only the `qinit`
binary — no clang, no cmake, no nasm.

Paired decision: the **node** is no longer built locally — `qinit node get` downloads a
prebuilt testnet+dynamic `Qubic` from GitHub releases (#6). So both halves of the flow
(compile, node) become "fetch + run", pinned by a release manifest.

**Non-goals.** Not changing the deploy/upload/call path, the wrapper recipe, or the host
ABI. Not supporting non-x86-64 node targets. Not embedding a C++ STL we don't already use.

## What the wasm toolchain must reproduce (measured, not guessed)

Current native recipe (`packages/build/src/recipe.ts`):
- flags: `-std=c++20 -O2 -fPIC -shared -fno-rtti -mavx2 -I<core> -I<core>/src`
- target: host = `x86_64-unknown-linux-gnu`
- `-mavx2` is **mandatory** — `m256i` pass-by-value ABI must match the host. X86 backend supports it.
- wrapper pulls real STL headers: `<cstdint> <cstddef> <cstring> <cstdlib> <string>
  <type_traits> <utility> <array> <limits>`. **Not freestanding** — `<string>` drags
  libstdc++ `bits/*`. → the wasm cc1 needs an x86-64-linux **libstdc++ + glibc header sysroot**.

Current `.so` (measured on `dist/contracts/Counter.so`):
- `NEEDED`: `libstdc++.so.6, libm.so.6, libgcc_s.so.1, libc.so.6`
- 32 `UND` symbols (`_Unwind_Resume`, `__gmon_start__`, `_ITM_*`, glibc/libstdc++) — resolved
  at **dlopen** against the node process (which already links all four). The QPI host symbols
  are bound via the `g_liteHost` vtable pointer, **not** dynamic symbols.

## Stage-0 spike results (native, measured 2026-06-03)

Native two-step proven end-to-end; the wasm artifact is the sole remaining gate.

- **two-step split works.** `clang++-18 -c wrapper.cpp -o Counter.o` (in-process cc1) →
  `ld.lld -shared … -o .so`. clang only forks for the linker, so split = required + sufficient.
- **headers-only sysroot is DEAD.** A no-lib `ld.lld -shared` `.so` (no NEEDED, 24 UND) **segvs at
  dlopen** — missing crt init framing (`crtbeginS/crtendS`), not a symbol error. → **option (B)**.
- **validated sysroot recipe** (raw `ld.lld`, no driver → dlopen OK, correct NEEDED):
  ```
  ld.lld -shared crti.o crtbeginS.o Counter.o \
    -L<gcc-lib> -L/usr/lib/x86_64-linux-gnu -L/lib/x86_64-linux-gnu \
    -lstdc++ -lm -lgcc_s -lgcc -lc  crtendS.o crtn.o -o out.so
  ```
  So lld.wasm must be fed: `{crti,crtbeginS,crtendS,crtn}.o` + those `-L` + `-lstdc++ -lm -lgcc_s -lgcc -lc`.
- **the gate — no prebuilt clang.wasm emits x86-64 ELF.** YoWASP/clang (mature clang-in-wasm,
  LLVM 18.1.2, runs under wasmtime) builds `LLVM_TARGETS_TO_BUILD=WebAssembly` **only**. All
  prebuilt clang-in-wasm target *wasm output* (browser use case). #7 therefore needs a **custom
  cross-build of LLVM 18 → wasm32-wasi with `X86;WebAssembly`** (+ ELF lld), using the YoWASP
  `llvm-project` `main+wasm` patch set (upstream LLVM doesn't build clean to wasm yet) + wasi-sdk.
  Multi-hour, fragile, ~tens of GB. **This is the go/no-go cost.**

## The two hard mechanics (both have clean answers)

### 1. No subprocess spawn under WASI → split clang and lld
clang's driver runs the **frontend (`cc1`) in-process** by default (no fork) — so
`clang -c wrapper.cpp -o wrapper.o` works inside wasm. It only forks for the **linker**.
WASI can't fork. → run the link as a **separate** `lld.wasm` invocation:
```
clang.wasm  -target x86_64-unknown-linux-gnu -std=c++20 -O2 -fPIC -fno-rtti -mavx2 \
            -I<core> -I<core>/src --sysroot=<sysroot> -c wrapper.cpp -o wrapper.o
ld.lld      -shared wrapper.o -o Counter.so   [+ lib args — see §2]
```
(This is exactly the binji/wasm-clang pattern.) lld must be built with the **ELF** flavor.

### 2. Linker libs — measure, then pick the cheapest
Two options, decided by a Stage-0 measurement:
- **(A) headers-only sysroot** — link `ld.lld -shared wrapper.o` with **no** `-l`. The `.so`
  carries the UND symbols but no `NEEDED`. If the node dlopens such that process-global
  libstdc++/libc symbols resolve (they're loaded process-wide), it works → **ship headers only**,
  no target `.so` libs. Big simplification.
- **(B) stub libs** — if (A) fails to resolve at dlopen, ship tiny stub `.so`s (correct SONAME,
  exporting the referenced symbols) for `libstdc++/libm/libgcc_s/libc` so lld records `NEEDED`.
  Symbols still bind to the real libs in-node at load.

De-risk by capturing the native driver's real link line once: `clang++-18 -### <args>` → see the
exact `ld` arg vector → port the minimal subset to `ld.lld`.

## Architecture

```
qinit (bun --compile, ~91M, ships small)
  └─ packages/toolchain  (new)
       ├─ fetch+cache:  ~/.cache/qinit/<ver>/{clang.wasm, lld.wasm, sysroot/, core-headers/}
       ├─ wasi runner:  instantiate wasm, preopen FS, run argv, capture rc+stderr
       └─ compileWasm(opts) -> { so, stderr, ok }   // drop-in alt to compile() native
  └─ packages/build/recipe.ts:  pick compileWasm() | compile() native | docker, by flag/auto
```

**Delivery = lazy fetch, not embed.** clang.wasm+lld.wasm+sysroot ≈ 50–150MB — too big to embed
in the bin via `--compile`. On first `build`/`deploy`, fetch from GitHub releases into
`~/.cache/qinit/<ver>/`, verify sha256, reuse after. `--offline` = cache only. Same mechanism as
`qinit node get`.

### Release manifest — the ABI linchpin
The `.so` is compiled against header structs/vtable that **must** match the running node.
A single versioned manifest pins the trio so they can't drift:
```jsonc
// github release asset: qinit-manifest-<ver>.json
{
  "version": "v0.1.0",
  "node":     { "url": "...Qubic", "sha256": "..." },          // #6 prebuilt node
  "toolchain":{ "clang": {url,sha}, "lld": {url,sha}, "llvm": "18.x" },
  "sysroot":  { "url": "...sysroot.tar.zst", "sha256": "..." },
  "headers":  { "url": "...core-headers.tar.zst", "sha256": "..." } // qpi.h, contract_def.h, ...
}
```
`qinit` reads the manifest for a pinned version → fetches the matching node + toolchain + headers.
`doctor` verifies the cache against it. One version number ⇒ ABI-consistent compile + node.

## Staged implementation (de-risk order; each stage gates the next)

**Stage 0 — manual spike (the go/no-go).** No qinit code. By hand:
1. Cross-build LLVM 18 → `wasm32-wasi` with `LLVM_TARGETS_TO_BUILD="X86;WebAssembly"`, using
   wasi-sdk as host compiler → `clang.wasm` + `ld.lld` (ELF). (Or locate a prebuilt LLVM-18 wasm.)
2. Assemble a minimal x86-64-linux header sysroot (libstdc++ + glibc headers).
3. Run the two-step compile of the existing `Counter.wrapper.cpp` under **wasmtime CLI** → `Counter.so`.
4. **dlopen it in the prebuilt node, call `Get`** → must return a value.
5. Measure §2 (A) vs (B): does the no-lib `.so` resolve at dlopen?
   **Kill criterion:** if (3) or (4) can't produce a loadable `.so` after reasonable effort →
   stop #7, ship **#5 (docker)** as the zero-host-clang answer; keep #7 as research.

**Stage 1 — bun WASI runtime.** Replace wasmtime CLI with Bun's WASI: instantiate clang.wasm,
preopen {sysroot, core-headers, tmp}, feed argv, get `wrapper.o`; same for lld.wasm → `.so`.
Resolve WASI gaps (cwd, clock, memory `maximum`, any missing syscall). **Kill criterion:** if
LLVM needs a syscall bun's WASI lacks and can't be shimmed → embed `wasmtime` (note: re-adds a
native dep) or fall back to docker.

**Stage 2 — sysroot + headers packaging.** Produce the minimal sysroot + core-header snapshot
that compiles the **whole fixture matrix** (Counter, Bank=HashMap, Proxy=inter-contract, Token=assets,
Logger). The fixtures are the regression suite. Tar+zstd; record shas.

**Stage 3 — qinit integration.** `packages/toolchain` (fetch/cache/verify + WASI runner +
`compileWasm`). `recipe.ts` selects path: `--toolchain wasm|native|docker` (auto = wasm if cache
present else native). `qinit build`/`deploy` unchanged downstream. `--offline`, `--ref <ver>`.

**Stage 4 — node-from-github (#6) + manifest.** `qinit node get [--ref]` downloads the prebuilt
node, `qinit node run` (scratch dir, `--node-mode 3 --ticking-delay 1000`, wait-for-tick — all
footguns baked in). CI release workflow publishes node + toolchain + sysroot + headers + manifest.
`doctor` verifies cache vs manifest.

**Stage 5 — polish.** `doctor` reports toolchain source (wasm/native/docker) + version. `qinit dev`
watch loop on the wasm path (edit `.h` → auto build+deploy). README "install = download one binary".

## Risks
- **Producing clang.wasm+lld.wasm with X86 ELF output** is the real work (Stage 0). Highest risk.
- **Bun WASI maturity** — LLVM is syscall-heavy; may force an embedded runtime (Stage 1 kill).
- **Size/first-run latency** — mitigated by lazy fetch + cache + `--offline`.
- **ABI drift** — mitigated by the single-version manifest pinning node+headers+toolchain.
- **wasm clang speed** — ~2–5× native, but contract TU is tiny → ~1–2s, acceptable.

## Fallback
#5 (docker compile) delivers ~90% of the benefit (host needs only docker) for ~10% of the effort.
If Stage 0 or 1 hits its kill criterion, ship docker as the "no host clang" path and keep #7 research.
